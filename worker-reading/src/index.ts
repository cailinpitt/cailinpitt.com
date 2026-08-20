// Reading API for cailinpitt.com/reading.
//
//  scheduled (daily): pull the hardcover.app library into D1 and mirror new
//    cover art to R2.
//  fetch: serve the bundle from D1 behind the edge cache, and manage articles
//    at /ingest (POST save, PATCH note, DELETE remove). No KV — see store.ts.

import { annotateArticle, deleteArticle, ingestArticle, resolveId } from './articles'
import {
  ARTICLE_PAGE,
  BOOK_PAGE,
  buildBundle,
  buildNow,
  fetchArticles,
  fetchFinishedBooks,
} from './store'
import { syncBooks } from './sync'
import { renderText } from './text'

/** Edge-cache lifetime. The underlying data changes daily, or when you save one. */
const EDGE_TTL = 300

// Split from one TTL into two: max-age is what a person will wait for a fresh
// page, s-maxage is what bounds D1 load per colo per window — they don't need
// to match. stale-while-revalidate serves instantly while refreshing behind it.
const LIVE_TTL = { browser: 60, edge: EDGE_TTL }

/** Where a browser landing on the API gets sent. */
const SITE_READING = 'https://cailinpitt.com/reading'

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

// /ingest is callable from any origin, unlike the read endpoints: the
// bookmarklet runs in whatever page is open, so an allowlist can't work. The
// bearer token is the boundary — worst case a leaked one adds an article.
const INGEST_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

// The iOS Shortcut's "Get URLs from Input" produces a list, serialized as
// `{"url": ["https://…"]}` rather than a bare string — coerce rather than
// making every caller add a "Get Item from List" step.
function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' && v.trim())
    return typeof first === 'string' ? first.trim() : null
  }
  return null
}

/** The local calendar year, for the "this year" counts. */
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

/** For the mutating endpoints: never cached, CORS applied directly. */
function jsonNoStore(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cors,
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
      syncBooks(env)
        .then((result) => console.log(JSON.stringify({ level: 'info', sync: result })))
        .catch((err) =>
          console.log(JSON.stringify({ level: 'error', stage: 'sync', error: String(err) })),
        ),
    )
  },

  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    const cors = url.pathname === '/ingest' ? INGEST_CORS : corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    try {
      // curl → terminal view, checked before the browser redirect below.
      if ((url.pathname === '/' || url.pathname === '/reading') && wantsText(request, url)) {
        const offset = Number(env.TZ_OFFSET_SECONDS) || 0
        return cached(url, 'text', ctx, cors, async () =>
          textResponse(
            renderText(await buildBundle(env.DB, localYear(offset)), {
              // ?T disables color, matching wttr.in's convention.
              color: !url.searchParams.has('T'),
              offset,
              year: localYear(offset),
            }),
          ),
        )
      }

      // One path, three verbs, keyed by url (or id): POST save, PATCH note, DELETE drop.
      if (url.pathname === '/ingest') {
        if (!authorized(request, env.INGEST_TOKEN)) {
          return new Response('Unauthorized', { status: 401, headers: cors })
        }

        const payload = (await request.json().catch(() => null)) as {
          url?: unknown
          id?: unknown
          note?: unknown
          append?: unknown
        } | null
        const target = asText(payload?.url)
        const givenId = asText(payload?.id)
        const note = asText(payload?.note)

        if (request.method === 'POST') {
          if (!target) {
            return jsonNoStore(
              { error: 'expected a JSON body with a "url" string', received: payload?.url ?? null },
              400,
              cors,
            )
          }
          const result = await ingestArticle(env, { url: target, note })
          if (!result) return jsonNoStore({ error: `not a usable url: ${target}` }, 400, cors)
          console.log(JSON.stringify({ level: 'info', ingest: result }))
          return jsonNoStore(result, 200, cors)
        }

        if (request.method === 'PATCH' || request.method === 'DELETE') {
          const id = await resolveId({ url: target, id: givenId })
          if (!id) {
            return jsonNoStore({ error: 'expected a JSON body with "url" or "id"' }, 400, cors)
          }

          if (request.method === 'DELETE') {
            const removed = await deleteArticle(env, id)
            console.log(JSON.stringify({ level: 'info', delete: { id, removed } }))
            return removed
              ? jsonNoStore({ id, deleted: true }, 200, cors)
              : jsonNoStore({ id, error: 'no such article' }, 404, cors)
          }

          const updated = await annotateArticle(env, id, note, payload?.append === true)
          return updated
            ? jsonNoStore(updated, 200, cors)
            : jsonNoStore({ id, error: 'no such article' }, 404, cors)
        }

        return new Response('Method not allowed', { status: 405, headers: cors })
      }

      // Runs the daily sync on demand — for the cover backfill (see MIRROR_BUDGET)
      // and to pick up a finished book without waiting for the cron.
      if (url.pathname === '/sync') {
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405, headers: cors })
        }
        if (!authorized(request, env.ADMIN_TOKEN)) {
          return new Response('Unauthorized', { status: 401, headers: cors })
        }
        // Reported to the caller, not just the log — this route is authenticated
        // and failures (schema not applied, missing token) are worth seeing now.
        let body: string
        let status = 200
        try {
          const result = await syncBooks(env)
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
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          }),
          cors,
        )
      }

      if (url.pathname === '/reading.json') {
        return cached(url, 'bundle', ctx, cors, async () =>
          json(await buildBundle(env.DB, localYear(Number(env.TZ_OFFSET_SECONDS) || 0)), LIVE_TTL),
        )
      }

      // Small payload for the homepage strip — see buildNow().
      if (url.pathname === '/now.json') {
        return cached(url, 'now', ctx, cors, async () => json(await buildNow(env.DB, Number(env.TZ_OFFSET_SECONDS) || 0), LIVE_TTL))
      }

      if (url.pathname === '/books') {
        return cached(url, 'books', ctx, cors, async () => {
          const cursor = url.searchParams.get('cursor')
          const limit = Number(url.searchParams.get('limit')) || BOOK_PAGE
          return json(await fetchFinishedBooks(env.DB, cursor, limit), LIVE_TTL)
        })
      }

      if (url.pathname === '/articles') {
        return cached(url, 'articles', ctx, cors, async () => {
          const cursor = url.searchParams.get('cursor')
          const limit = Number(url.searchParams.get('limit')) || ARTICLE_PAGE
          return json(await fetchArticles(env.DB, cursor, limit), LIVE_TTL)
        })
      }

      // 302 + no-store: this response is User-Agent dependent (terminal view
      // shares the path), so a cached redirect could break `curl` for this URL.
      if (url.pathname === '/' || url.pathname === '/reading') {
        return new Response(null, {
          status: 302,
          headers: { location: SITE_READING, 'cache-control': 'no-store', ...cors },
        })
      }

      return new Response('Not found', { status: 404, headers: cors })
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', route: url.pathname, error: String(err) }))
      return new Response('Internal error', { status: 500, headers: cors })
    }
  },
} satisfies ExportedHandler<Env>
