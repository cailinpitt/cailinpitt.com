// Watching API for cailinpitt.com/watching.
//
//  scheduled (daily): pull the Letterboxd diary feed into D1 and mirror new
//    poster art to R2.
//  fetch: serve the bundle from D1 behind the edge cache. No ingest endpoint —
//    the feed is pulled, never pushed. No KV — see store.ts.

import { sync } from './sync'
import { FILM_PAGE, buildBundle, buildNow, fetchFilms, fetchFilmsOnDate } from './store'
import { renderText } from './text'

/** Edge-cache lifetime. The underlying data changes daily at most. */
const EDGE_TTL = 300

// Split from one TTL into two: max-age is what a person will wait for a fresh
// page, s-maxage is what bounds D1 load per colo per window — they don't need
// to match. stale-while-revalidate serves instantly while refreshing behind it.
const LIVE_TTL = { browser: 60, edge: EDGE_TTL }

/** Where a browser landing on the API gets sent. */
const SITE_WATCHING = 'https://cailinpitt.com/watching'

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

/** The local calendar year, for the "this year" count. */
function localYear(offsetSeconds: number): number {
  return new Date((Date.now() / 1000 + offsetSeconds) * 1000).getUTCFullYear()
}

// Any loopback port, so a dev server on a different port still works. This
// data is already public, so the allowlist is about not being a free CORS
// backend for other origins, not guarding secrets.
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

// Deliberately narrow: anything not clearly a CLI fetcher gets the normal redirect.
const CLI_AGENT = /^(curl|wget|httpie|HTTPie|xh|powershell|fetch)\b/i

function wantsText(request: Request, url: URL): boolean {
  if (url.searchParams.has('format') || url.searchParams.has('json')) return false
  const ua = request.headers.get('user-agent') ?? ''
  return CLI_AGENT.test(ua)
}

/** Like json(): omits CORS so the cached entry stays origin-independent. */
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

// Variant folded into the URL so one path can safely produce more than one body.
const cacheKey = (url: URL, variant: string): Request => {
  const key = new URL(url.toString())
  key.searchParams.set('__variant', variant)
  return new Request(key.toString(), { method: 'GET' })
}

/** Serve `build()` through the edge cache, adding this request's CORS on the way out. */
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
  // Only success is worth storing; errors should retry immediately.
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
      // curl → terminal view, checked before the browser redirect below.
      if ((url.pathname === '/' || url.pathname === '/watching') && wantsText(request, url)) {
        const year = localYear(Number(env.TZ_OFFSET_SECONDS) || 0)
        return cached(url, 'text', ctx, cors, async () =>
          textResponse(
            renderText(await buildBundle(env.DB, year), {
              // ?T disables color, matching wttr.in's convention.
              color: !url.searchParams.has('T'),
              year,
            }),
          ),
        )
      }

      // Runs the daily sync on demand — for the poster backfill (see
      // MIRROR_BUDGET) and to pick up a film without waiting for the cron.
      if (url.pathname === '/sync') {
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405, headers: cors })
        }
        if (!authorized(request, env.ADMIN_TOKEN)) {
          return new Response('Unauthorized', { status: 401, headers: cors })
        }
        // Reported to the caller, not just the log — this route is authenticated
        // and failures (schema not applied, Letterboxd 403ing the IP) are worth
        // seeing now.
        let body: string
        let status = 200
        try {
          const result = await sync(env)
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

      if (url.pathname === '/watching.json') {
        return cached(url, 'bundle', ctx, cors, async () =>
          json(await buildBundle(env.DB, localYear(Number(env.TZ_OFFSET_SECONDS) || 0)), LIVE_TTL),
        )
      }

      // Small payload for the terminal — see buildNow().
      if (url.pathname === '/now.json') {
        return cached(url, 'now', ctx, cors, async () => json(await buildNow(env.DB), LIVE_TTL))
      }

      if (url.pathname === '/films') {
        const date = url.searchParams.get('date')
        if (date) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Bad date', { status: 400, headers: cors })
          return cached(url, 'films-on', ctx, cors, async () =>
            json({ films: await fetchFilmsOnDate(env.DB, date) }, LIVE_TTL),
          )
        }
        return cached(url, 'films', ctx, cors, async () => {
          const cursor = url.searchParams.get('cursor')
          const limit = Number(url.searchParams.get('limit')) || FILM_PAGE
          return json(await fetchFilms(env.DB, cursor, limit), LIVE_TTL)
        })
      }

      // 302 + no-store: this response is User-Agent dependent (terminal view
      // shares the path), so a cached redirect could break `curl` for this URL.
      if (url.pathname === '/' || url.pathname === '/watching') {
        return new Response(null, {
          status: 302,
          headers: { location: SITE_WATCHING, 'cache-control': 'no-store', ...cors },
        })
      }

      return new Response('Not found', { status: 404, headers: cors })
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', route: url.pathname, error: String(err) }))
      return new Response('Internal error', { status: 500, headers: cors })
    }
  },
} satisfies ExportedHandler<Env>
