// Notes API for cailinpitt.com/notes — the microblog.
//
// The shape here is the inverse of the guestbook's. There, anyone may write and
// the interesting code is the gauntlet that decides whether to let them. Here
// exactly one person may write, the bearer token is the whole of that decision,
// and the interesting part is that a note is *live the moment it is published* —
// no build, no deploy, no commit.
//
//   phone Shortcut ─┐
//                   ├─→ POST /notes ─→ D1 ─→ GET /notes.json ─→ /notes page
//   compose page  ──┘                    └─→ GET /feed.xml
//
// ## Why nothing is prerendered
//
// The rest of the site is static HTML written at build time, and the photo
// pipeline goes to real trouble (a dispatch, a workflow, a commit) so that a
// photo from a phone is the same kind of object as one added from the laptop.
// Notes deliberately do not do that. A thought worth 480 characters is worth
// publishing in the two seconds it takes to type it, and a note that had to wait
// for a green CI run would simply not get written. The cost is real and is
// accepted: a note has no prerendered page, so it is addressed as an anchor on
// the feed (`/notes#<id>`) rather than a URL of its own, and search engines see
// the feed's shell rather than its contents. The RSS feed below is what keeps
// the notes syndicable anyway.
//
// ## Editing and deleting are first-class
//
// Both exist because publishing from a phone means publishing typos. An edit
// stamps `edited_at` and the site says so — a permalink that quietly changes
// what it said is the thing worth avoiding, not the edit itself.

import { renderFeed, FEED_ITEMS } from './feed'
import {
  deleteNote,
  insertNote,
  listNotes,
  updateNote,
  MAX_PAGE_SIZE,
  PAGE_SIZE,
  type Note,
} from './store'
import { renderText, TEXT_ROWS } from './text'
import { MAX_LENGTH, validate } from './validate'

/**
 * Edge-cache lifetime for the read endpoints.
 *
 * Short, and deliberately shorter than the settled-data endpoints elsewhere on
 * the site: the point of this feature is that a note appears immediately, and a
 * five-minute edge TTL would make "immediately" a lie for everyone but the
 * author. 30 seconds still collapses any realistic burst of traffic into one D1
 * query per colo, which is all the free tier needs.
 */
const EDGE_TTL = 30

/** The site this Worker serves notes for. Links in the feed and curl view. */
const SITE = 'https://cailinpitt.com'
const SITE_NOTES = `${SITE}/notes`

// ---- CORS ----------------------------------------------------------------

// Any loopback port, so a dev server on 5174 instead of 5173 still works without
// editing wrangler.jsonc.
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

const allowedOrigins = (env: Env) => env.ALLOWED_ORIGIN.split(',').map((o) => o.trim())

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('origin') ?? ''
  return allowedOrigins(env).includes(origin) || LOOPBACK.test(origin)
}

/**
 * Writes are reachable from any origin, unlike the guestbook's.
 *
 * The guestbook refuses an origin it doesn't know, because its write endpoint is
 * driven by a form on a page and anything else calling it is up to no good. This
 * one is driven by an iOS Shortcut as much as by the compose page — a share
 * sheet has no origin at all — so an origin check would reject the primary
 * client. The bearer token is the security boundary, and it is a real one in a
 * way an Origin header never was.
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin') ?? ''
  return {
    'access-control-allow-origin': originAllowed(request, env) ? origin : allowedOrigins(env)[0],
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    vary: 'origin',
  }
}

// ---- responses -----------------------------------------------------------

// The cached builders omit CORS: it varies by Origin and is applied by withCors()
// after the cache, so a cached entry stays origin-independent.

const cachedResponse = (body: string, contentType: string, maxAge: number): Response =>
  new Response(body, {
    headers: {
      'content-type': contentType,
      // max-age is what a browser holds, s-maxage what the edge holds. See the
      // Caching section of the site README on why they are stated separately.
      'cache-control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    },
  })

const json = (body: unknown, maxAge: number): Response =>
  cachedResponse(JSON.stringify(body), 'application/json; charset=utf-8', maxAge)

/** For everything that must never be cached: writes, errors. */
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

// ---- edge cache ----------------------------------------------------------
//
// Cloudflare does not cache Worker-generated responses on its own, so without
// this every reader executes the Worker and its D1 query. Same helper as the
// other workers.

const cacheKey = (url: URL, variant: string): Request => {
  const key = new URL(url.toString())
  key.searchParams.set('__variant', variant)
  return new Request(key.toString(), { method: 'GET' })
}

function withCors(res: Response, cors: Record<string, string>): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
  return out
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

/**
 * Drop the cached reads after a write.
 *
 * Without this, publishing from the compose page and then opening /notes on a
 * phone could show a feed up to EDGE_TTL seconds old that doesn't have the note
 * in it — the exact moment someone checks, and the exact moment being stale
 * looks like a bug rather than a cache. The compose page prepends its own note
 * locally, so this is for every *other* view: the feed on another device, the
 * homepage strip, the RSS reader that polls a second later.
 *
 * Only the unparameterized keys are purged. A deep page of older notes is
 * addressed by cursor and cannot be affected by a note added at the top.
 */
function purge(ctx: ExecutionContext): void {
  const keys = [
    cacheKey(new URL(`${SITE}/notes.json`), 'json'),
    cacheKey(new URL(`${SITE}/now.json`), 'now'),
    cacheKey(new URL(`${SITE}/feed.xml`), 'feed'),
    cacheKey(new URL(`${SITE}/`), 'text'),
  ]
  ctx.waitUntil(Promise.all(keys.map((key) => caches.default.delete(key))))
}

// ---- auth ----------------------------------------------------------------

/**
 * Bearer-token check for every write route.
 *
 * Compared in constant time. This is the only thing standing between the
 * internet and the contents of the microblog, so it is worth doing properly;
 * length is allowed to leak, the contents are not.
 */
function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (token.length !== secret.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i)
  return diff === 0
}

// ---- curl detection ------------------------------------------------------

const CLI_AGENT = /^(curl|wget|httpie|HTTPie|xh|powershell|fetch)\b/i

function wantsText(request: Request, url: URL): boolean {
  if (url.searchParams.has('format') || url.searchParams.has('json')) return false
  return CLI_AGENT.test(request.headers.get('user-agent') ?? '')
}

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

// ---- the write path ------------------------------------------------------

/**
 * Read `text` from whichever shape the client found easiest to send.
 *
 * JSON is what the compose page posts. The form and plain-text shapes exist for
 * Shortcuts, whose "Get Contents of URL" action makes JSON awkward to build by
 * hand but form fields trivial — the same accommodation worker-photos makes, and
 * for the same reason: the client that is hardest to debug should have the
 * easiest path.
 */
async function readText(request: Request): Promise<unknown> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()

  if (contentType.includes('application/json')) {
    const payload = (await request.json().catch(() => null)) as { text?: unknown } | null
    return payload?.text
  }
  if (
    contentType.includes('form-data') ||
    contentType.includes('application/x-www-form-urlencoded')
  ) {
    const form = await request.formData().catch(() => null)
    return form?.get('text') ?? undefined
  }
  // Anything else: the body itself is the note. `curl -d 'a thought'` lands here.
  return await request.text().catch(() => '')
}

async function publish(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Record<string, string>,
): Promise<Response> {
  if (!authorized(request, env.PUBLISH_TOKEN)) {
    return jsonNoStore({ error: 'unauthorized' }, 401, cors)
  }

  const checked = validate({ text: await readText(request) })
  if (!checked.ok) return jsonNoStore({ error: checked.error }, 400, cors)

  const note = await insertNote(env.DB, checked.value)
  purge(ctx)
  log({ level: 'info', published: { id: note.id, length: [...note.text].length } })

  // The created row goes back so the client can show it immediately rather than
  // re-reading through a cache it just invalidated, and so a Shortcut can put
  // the permalink in its notification.
  return jsonNoStore({ ok: true, note, url: `${SITE_NOTES}#${note.id}` }, 201, cors)
}

async function edit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Record<string, string>,
  id: string,
): Promise<Response> {
  if (!authorized(request, env.PUBLISH_TOKEN)) {
    return jsonNoStore({ error: 'unauthorized' }, 401, cors)
  }

  const checked = validate({ text: await readText(request) })
  if (!checked.ok) return jsonNoStore({ error: checked.error }, 400, cors)

  const note = await updateNote(env.DB, id, checked.value)
  if (!note) return jsonNoStore({ id, error: 'no such note' }, 404, cors)
  purge(ctx)
  log({ level: 'info', edited: { id } })

  return jsonNoStore({ ok: true, note, url: `${SITE_NOTES}#${note.id}` }, 200, cors)
}

async function remove(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Record<string, string>,
  id: string,
): Promise<Response> {
  if (!authorized(request, env.PUBLISH_TOKEN)) {
    return jsonNoStore({ error: 'unauthorized' }, 401, cors)
  }
  const removed = await deleteNote(env.DB, id)
  if (removed) purge(ctx)
  log({ level: 'info', deleted: { id, removed } })

  return removed
    ? jsonNoStore({ id, deleted: true }, 200, cors)
    : jsonNoStore({ id, error: 'no such note' }, 404, cors)
}

// ---- worker --------------------------------------------------------------

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    const url = new URL(request.url)
    try {
      // ---- writes (PUBLISH_TOKEN only, never cached) ----

      if (url.pathname === '/notes' && request.method === 'POST') {
        return await publish(request, env, ctx, cors)
      }

      const single = url.pathname.match(/^\/notes\/([a-f0-9]{4,32})$/)
      if (single && request.method === 'PATCH') {
        return await edit(request, env, ctx, cors, single[1])
      }
      if (single && request.method === 'DELETE') {
        return await remove(request, env, ctx, cors, single[1])
      }

      // ---- reads (public, edge-cached) ----

      if (url.pathname === '/notes.json') {
        return await cached(url, 'json', ctx, cors, async () =>
          json(
            await listNotes(env.DB, {
              before: url.searchParams.get('before'),
              limit: Number(url.searchParams.get('limit')) || PAGE_SIZE,
            }),
            EDGE_TTL,
          ),
        )
      }

      // Just the newest note, for the homepage strip — the same shape the other
      // workers' /now.json endpoints have, so the homepage treats it the same way.
      if (url.pathname === '/now.json') {
        return await cached(url, 'now', ctx, cors, async () => {
          const { notes, total } = await listNotes(env.DB, { limit: 1 })
          return json({ latest: notes[0] ?? null, total }, EDGE_TTL)
        })
      }

      if (url.pathname === '/feed.xml') {
        return await cached(url, 'feed', ctx, cors, async () =>
          cachedResponse(
            renderFeed(
              await listNotes(env.DB, { limit: FEED_ITEMS }),
              SITE,
              `${url.origin}/feed.xml`,
            ),
            'application/rss+xml; charset=utf-8',
            EDGE_TTL,
          ),
        )
      }

      // The numbers the compose page enforces client-side, served rather than
      // duplicated, so the counter cannot disagree with validate.ts.
      if (url.pathname === '/limits.json') {
        return await cached(url, 'limits', ctx, cors, async () =>
          json({ maxLength: MAX_LENGTH, pageSize: PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE }, 86_400),
        )
      }

      // `curl notes.cailinpitt.com` → the terminal view. Checked before the
      // redirect below, which is what a browser on the same path gets instead.
      if ((url.pathname === '/' || url.pathname === '/notes') && wantsText(request, url)) {
        return await cached(url, 'text', ctx, cors, async () =>
          cachedResponse(
            renderText(await listNotes(env.DB, { limit: TEXT_ROWS }), {
              // ?T disables color, matching wttr.in's convention.
              color: !url.searchParams.has('T'),
              offset: Number(env.TZ_OFFSET_SECONDS) || 0,
              site: SITE,
            }),
            'text/plain; charset=utf-8',
            EDGE_TTL,
          ),
        )
      }

      // Same paths in a browser: the real page rather than a 404. 302 and
      // no-store, because this response is User-Agent dependent — a cached
      // permanent redirect could later be replayed to a client that wanted the
      // terminal view, which would break `curl` for this URL.
      if (url.pathname === '/' || url.pathname === '/notes') {
        return new Response(null, {
          status: 302,
          headers: { location: SITE_NOTES, 'cache-control': 'no-store', ...cors },
        })
      }

      return new Response('Not found', { status: 404, headers: cors })
    } catch (err) {
      log({ level: 'error', route: url.pathname, error: String(err) })
      return new Response('Internal error', { status: 500, headers: cors })
    }
  },
} satisfies ExportedHandler<Env>

export type { Note }
