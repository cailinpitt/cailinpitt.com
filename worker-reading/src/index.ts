// Reading API for cailinpitt.com/reading.
//
//  scheduled (daily): pull the whole hardcover.app library into D1 and mirror
//    any new cover art to R2. Books change a few times a week at most, so
//    there is nothing here that needs the listening worker's per-minute cadence.
//  fetch: serve the bundle straight from D1 behind the edge cache, and manage
//    articles at /ingest (POST to save, PATCH to note, DELETE to remove) from
//    the share-sheet Shortcuts and the bookmarklets. No KV: at this data
//    volume precomputed blobs would be complexity without a payoff (see the note
//    at the top of src/store.ts).

import { annotateArticle, deleteArticle, ingestArticle, resolveId } from './articles'
import { ARTICLE_PAGE, BOOK_PAGE, buildBundle, fetchArticles, fetchFinishedBooks } from './store'
import { syncBooks } from './sync'

/** Edge-cache lifetime. The underlying data changes daily, or when you save one. */
const EDGE_TTL = 300

/** Where a browser landing on the API gets sent. */
const SITE_READING = 'https://cailinpitt.com/reading'

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

/**
 * `/ingest` is callable from any origin, unlike the read endpoints.
 *
 * The bookmarklet runs in the page context of whatever article is open, so the
 * origin is arbitrary by design and an allowlist can't work. The bearer token is
 * the security boundary — without it every request is a 401 — and the worst a
 * leaked one can do is add an article to the log.
 */
const INGEST_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

/** The local calendar year, for the "this year" counts. */
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
      // The article endpoint. One path, three verbs, all keyed by url (or id):
      //   POST   save it            PATCH  note it            DELETE  drop it
      // The share-sheet Shortcuts and the bookmarklets all talk to this.
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
        const target = typeof payload?.url === 'string' ? payload.url : null
        const givenId = typeof payload?.id === 'string' ? payload.id : null
        const note = typeof payload?.note === 'string' ? payload.note : null

        if (request.method === 'POST') {
          if (!target) {
            return jsonNoStore({ error: 'expected a JSON body with a "url" string' }, 400, cors)
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

      // Run the daily sync on demand. This exists because the cover backfill
      // needs many passes (see MIRROR_BUDGET) and because there is otherwise no
      // way to pick up a book you just finished without waiting for 09:00 UTC.
      // Never cached, and 401s without the ADMIN_TOKEN secret.
      if (url.pathname === '/sync') {
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405, headers: cors })
        }
        if (!authorized(request, env.ADMIN_TOKEN)) {
          return new Response('Unauthorized', { status: 401, headers: cors })
        }
        // Report the failure to the caller rather than only to the log. This
        // route is authenticated, so there is nothing to leak, and the common
        // failures (schema not applied, HARDCOVER_TOKEN unset) are ones you want
        // to see immediately instead of going digging in `wrangler tail`.
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
          json(await buildBundle(env.DB, localYear(Number(env.TZ_OFFSET_SECONDS) || 0)), EDGE_TTL),
        )
      }

      if (url.pathname === '/books') {
        return cached(url, 'books', ctx, cors, async () => {
          const cursor = url.searchParams.get('cursor')
          const limit = Number(url.searchParams.get('limit')) || BOOK_PAGE
          return json(await fetchFinishedBooks(env.DB, cursor, limit), EDGE_TTL)
        })
      }

      if (url.pathname === '/articles') {
        return cached(url, 'articles', ctx, cors, async () => {
          const cursor = url.searchParams.get('cursor')
          const limit = Number(url.searchParams.get('limit')) || ARTICLE_PAGE
          return json(await fetchArticles(env.DB, cursor, limit), EDGE_TTL)
        })
      }

      // A browser on the bare API host gets sent to the real page, not a 404.
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
