// Activity API for cailinpitt.com/moving.
//
//  scheduled (daily): pull recent activities from Strava into D1.
//  fetch: serve the bundle from D1 behind the edge cache, plus an authenticated
//    /sync used for the initial backfill and to pick up a ride on demand.

import { sync } from './sync'
import {
  ACTIVITY_PAGE,
  buildBundle,
  buildNow,
  fetchActivities,
  fetchActivitiesOnDate,
  fetchWindows,
} from './store'
import { renderText } from './text'

const EDGE_TTL = 300

// Split from one TTL into two: max-age is what a person will wait for a fresh
// page, s-maxage bounds D1 load per colo per window. With the cron pulling
// every 30 min, a shared TTL made a ride invisible for the whole window after
// it landed. stale-while-revalidate serves instantly while refreshing behind it.
const LIVE_TTL = { browser: 60, edge: EDGE_TTL }

// Read by the listening Worker's cron when it builds a period. Past activities
// never change, so this caches far longer than the feed.
const WINDOW_EDGE_TTL = 3600
const WINDOW_TTL = { browser: WINDOW_EDGE_TTL, edge: WINDOW_EDGE_TTL }

const SITE_MOVING = 'https://cailinpitt.com/moving'

/** Constant-time compare, so /sync's token can't be recovered by timing. */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function authorized(request: Request, secret: string | undefined): boolean {
  const header = request.headers.get('authorization') ?? ''
  const token = header.replace(/^Bearer\s+/i, '')
  return Boolean(secret) && Boolean(token) && secretEquals(token, secret as string)
}

function localYear(offsetSeconds: number): number {
  return new Date((Date.now() / 1000 + offsetSeconds) * 1000).getUTCFullYear()
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN.split(',').map((o) => o.trim())
  const origin = request.headers.get('origin') ?? ''
  const ok = allowed.includes(origin) || LOOPBACK.test(origin)
  return {
    'access-control-allow-origin': ok ? origin : allowed[0],
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  }
}

// Omits CORS deliberately: it varies by Origin and is applied by withCors()
// after the cache, so a cached entry stays origin-independent.
function json(body: unknown, ttl: { browser: number; edge: number }): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control':
        `public, max-age=${ttl.browser}, s-maxage=${ttl.edge}` +
        `, stale-while-revalidate=${ttl.edge}`,
    },
  })
}

const CLI_AGENT = /^(curl|wget|httpie|HTTPie|xh|powershell|fetch)\b/i

function wantsText(request: Request, url: URL): boolean {
  if (url.searchParams.has('format') || url.searchParams.has('json')) return false
  const ua = request.headers.get('user-agent') ?? ''
  return CLI_AGENT.test(ua)
}

function textResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': `public, max-age=${EDGE_TTL}`,
    },
  })
}

function withCors(res: Response, cors: Record<string, string>): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
  return out
}

/** Variant folded into the URL, so one path can produce more than one body. */
const cacheKey = (url: URL, variant: string): Request => {
  const key = new URL(url.toString())
  key.searchParams.set('__variant', variant)
  return new Request(key.toString(), { method: 'GET' })
}

async function cached(
  url: URL,
  variant: string,
  ctx: ExecutionContext,
  cors: Record<string, string>,
  build: () => Promise<Response>,
): Promise<Response> {
  const key = cacheKey(url, variant)
  const hit = await caches.default.match(key)
  if (hit) return withCors(hit, cors)

  const fresh = await build()
  if (fresh.status === 200) ctx.waitUntil(caches.default.put(key, fresh.clone()))
  return withCors(fresh, cors)
}

export default {
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      sync(env)
        .then((result) => console.log(JSON.stringify({ level: 'info', sync: result })))
        .catch((err) =>
          console.log(JSON.stringify({ level: 'error', stage: 'sync', error: String(err) })),
        ),
    )
  },

  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    try {
      if ((url.pathname === '/' || url.pathname === '/moving') && wantsText(request, url)) {
        const year = localYear(Number(env.TZ_OFFSET_SECONDS) || 0)
        return cached(url, 'text', ctx, cors, async () =>
          textResponse(
            renderText(await buildBundle(env.DB, year), {
              color: !url.searchParams.has('T'),
              year,
            }),
          ),
        )
      }

      // Runs the pull on demand. `?backfill=1` walks backwards into the archive
      // instead, a few pages per call; `?refresh=1&page=N` re-pulls history that
      // is already stored, to correct it — see PAGE_BUDGET in sync.ts.
      if (url.pathname === '/sync') {
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405, headers: cors })
        }
        if (!authorized(request, env.ADMIN_TOKEN)) {
          return new Response('Unauthorized', { status: 401, headers: cors })
        }
        // Reported to the caller, not just the log — this route is authenticated
        // and failures (schema not applied, stale refresh token) are worth seeing now.
        let body: string
        let status = 200
        try {
          const result = await sync(env, {
            backfill: url.searchParams.has('backfill'),
            refresh: url.searchParams.has('refresh'),
            page: Number(url.searchParams.get('page')) || undefined,
          })
          console.log(JSON.stringify({ level: 'info', sync: result }))
          body = JSON.stringify(result)
        } catch (err) {
          console.log(JSON.stringify({ level: 'error', stage: 'sync', error: String(err) }))
          body = JSON.stringify({ error: String(err) })
          status = 500
        }
        return withCors(
          new Response(body, {
            status,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          }),
          cors,
        )
      }

      if (url.pathname === '/moving.json') {
        return cached(url, 'bundle', ctx, cors, async () =>
          json(await buildBundle(env.DB, localYear(Number(env.TZ_OFFSET_SECONDS) || 0)), LIVE_TTL),
        )
      }

      if (url.pathname === '/now.json') {
        return cached(url, 'now', ctx, cors, async () => json(await buildNow(env.DB), LIVE_TTL))
      }

      // Bare time windows for the listening crossover — not part of /moving.json
      // since it's a different question at a different cadence.
      if (url.pathname === '/windows.json') {
        const from = Number(url.searchParams.get('from')) || 0
        const to = Number(url.searchParams.get('to')) || Math.floor(Date.now() / 1000)
        if (!(to > from)) return new Response('Bad range', { status: 400, headers: cors })
        return cached(url, 'windows', ctx, cors, async () =>
          json({ windows: await fetchWindows(env.DB, from, to) }, WINDOW_TTL),
        )
      }

      if (url.pathname === '/activities') {
        const date = url.searchParams.get('date')
        if (date) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Bad date', { status: 400, headers: cors })
          return cached(url, 'activities-on', ctx, cors, async () =>
            json({ activities: await fetchActivitiesOnDate(env.DB, date) }, LIVE_TTL),
          )
        }
        const cursor = url.searchParams.get('cursor')
        const kind = url.searchParams.get('kind')
        const limit = Number(url.searchParams.get('limit')) || ACTIVITY_PAGE
        return cached(url, `list:${kind ?? 'all'}`, ctx, cors, async () =>
          json(await fetchActivities(env.DB, cursor, limit, kind), LIVE_TTL),
        )
      }

      // 302 and no-store: this response is User-Agent dependent now that the
      // terminal view shares the path, so a cached permanent redirect could be
      // replayed to a client that wanted the text.
      if (url.pathname === '/' || url.pathname === '/moving') {
        return new Response(null, {
          status: 302,
          headers: { location: SITE_MOVING, 'cache-control': 'no-store', ...cors },
        })
      }

      return new Response('Not found', { status: 404, headers: cors })
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', route: url.pathname, error: String(err) }))
      return new Response('Internal error', { status: 500, headers: cors })
    }
  },
} satisfies ExportedHandler<Env>
