// Watching API for cailinpitt.com/watching.
//
//  scheduled (daily): pull the Letterboxd diary feed into D1 and mirror any
//    new poster art to R2. Same cadence as the reading worker, and for the same
//    reason — a run that finds nothing costs almost nothing, while a slower
//    cron just means a film sits unpublished for days. Nothing here needs the
//    listening worker's per-minute schedule.
//  fetch: serve the bundle straight from D1 behind the edge cache. There is no
//    ingest endpoint — the feed is pulled, never pushed.
//
// No KV, for the reason set out at the top of src/store.ts.

import { sync } from './sync'
import { FILM_PAGE, buildBundle, buildNow, fetchFilms } from './store'
import { renderText } from './text'

/** Edge-cache lifetime. The underlying data changes daily at most. */
const EDGE_TTL = 300

/** Where a browser landing on the API gets sent. */
const SITE_WATCHING = 'https://cailinpitt.com/watching'

/**
 * Constant-time string compare, so a token can't be recovered by timing the
 * `/sync` endpoint. Length is allowed to leak; the contents are not.
 */
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

// Any loopback port, so a dev server that lands on 5174 instead of 5173 still
// works without editing wrangler.jsonc. Everything this API serves is already
// public on the site, so the allowlist is about not being a free CORS backend
// for other origins — not about guarding secrets.
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

// Deliberately omits CORS: it varies by Origin and is applied by withCors()
// after the cache, so a cached entry stays origin-independent. Storing it would
// serve one visitor's access-control-allow-origin to everyone behind the same
// cache entry.
function json(body: unknown, maxAge: number): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
    },
  })
}

// Terminal client. Deliberately narrow: anything that is not clearly a CLI
// fetcher gets the normal redirect. Mirrors the other two workers' rule.
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

/**
 * Cache key. The variant is folded into the URL rather than keying on the raw
 * request so that one path can safely produce more than one body.
 */
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
      // `curl watching.cailinpitt.com` → the terminal view, the counterpart to
      // the other two workers'. Checked before the redirect below, which is
      // what a browser on the same path gets instead.
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

      // Run the daily sync on demand. This exists because the poster backfill
      // needs several passes (see MIRROR_BUDGET in sync.ts) and because there is
      // otherwise no way to pick up a film you just logged without waiting for
      // 09:00 UTC. Never cached, and 401s without the ADMIN_TOKEN secret.
      if (url.pathname === '/sync') {
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405, headers: cors })
        }
        if (!authorized(request, env.ADMIN_TOKEN)) {
          return new Response('Unauthorized', { status: 401, headers: cors })
        }
        // Report the failure to the caller rather than only to the log. This
        // route is authenticated, so there is nothing to leak, and the common
        // failures (schema not applied, Letterboxd 403ing the Worker's IP) are
        // ones you want to see immediately instead of going digging in
        // `wrangler tail`.
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
          json(await buildBundle(env.DB, localYear(Number(env.TZ_OFFSET_SECONDS) || 0)), EDGE_TTL),
        )
      }

      // Small payload for the terminal — see buildNow().
      if (url.pathname === '/now.json') {
        return cached(url, 'now', ctx, cors, async () => json(await buildNow(env.DB), EDGE_TTL))
      }

      if (url.pathname === '/films') {
        return cached(url, 'films', ctx, cors, async () => {
          const cursor = url.searchParams.get('cursor')
          const limit = Number(url.searchParams.get('limit')) || FILM_PAGE
          return json(await fetchFilms(env.DB, cursor, limit), EDGE_TTL)
        })
      }

      // A browser on the bare API host gets sent to the real page, not a 404.
      //
      // 302 and no-store, deliberately. This response is User-Agent dependent
      // now that the terminal view shares the path, so a permanent or
      // shared-cached redirect could later be replayed to a client that wanted
      // the text — which would break `curl` for that URL.
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
