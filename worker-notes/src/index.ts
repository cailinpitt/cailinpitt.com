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
//   compose page  ──┘                    ├─→ GET /feed.xml
//                                         └─→ GET cailinpitt.com/notes/<id>
//
// ## Why nothing is prerendered
//
// The rest of the site is static HTML written at build time, and the photo
// pipeline goes to real trouble (a dispatch, a workflow, a commit) so that a
// photo from a phone is the same kind of object as one added from the laptop.
// Notes deliberately do not do that. A thought worth 480 characters is worth
// publishing in the two seconds it takes to type it, and a note that had to wait
// for a green CI run would simply not get written. The cost is real and is
// accepted: a note has no page built for it at deploy time — instead this
// Worker renders one on demand at cailinpitt.com/notes/<id> (see permalink()
// below), on a route layered in front of the static site rather than baked
// into it, so a note is addressable the moment it exists rather than after
// the next deploy. The RSS feed below is what keeps notes syndicable to a
// reader that never visits the permalink at all.
//
// ## Editing and deleting are first-class
//
// Both exist because publishing from a phone means publishing typos. An edit
// stamps `edited_at` and the site says so — a permalink that quietly changes
// what it said is the thing worth avoiding, not the edit itself.

import { renderFeed, FEED_ITEMS, title as noteTitle, xml as escapeXml } from './feed'
import {
  deleteNote,
  getNote,
  insertNote,
  listNotes,
  updateNote,
  MAX_PAGE_SIZE,
  PAGE_SIZE,
  type Note,
} from './store'
import { renderNoteText, renderText, TEXT_ROWS } from './text'
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
 * Every cached read, as `[path, variant]`.
 *
 * One list, used by `purge()`. The variants have to be exactly the strings the
 * routes below pass to `cached()`, since the variant is part of the key — a
 * typo here purges nothing and looks like nothing at all, which is how the
 * original version of this went unnoticed.
 *
 * Only unparameterized paths appear. A deep page of older notes is addressed by
 * cursor and cannot be affected by a note added at the top, and `/limits.json`
 * is constant.
 */
const CACHED_READS: [path: string, variant: string][] = [
  ['/notes.json', 'json'],
  ['/now.json', 'now'],
  ['/feed.xml', 'feed'],
  // The terminal view answers on two paths and caches under each separately,
  // since the path is part of the key. Purging only one leaves `curl` on the
  // other showing a feed without the new note in it.
  ['/', 'text'],
  ['/notes', 'text'],
]

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
 * **`origin` must be the origin the read was cached under**, i.e. this Worker's
 * own hostname, and it is taken from the incoming request rather than written
 * down. It used to be built from `SITE` — `https://cailinpitt.com` — while
 * `cached()` keys entries by the request URL, `https://notes.cailinpitt.com`.
 * The two never matched, so every purge deleted nothing and every reader waited
 * out the full TTL. Deriving it from the request is what makes the two sides
 * agree by construction: there is no second copy of the hostname to get wrong,
 * and it keeps working on a preview deployment or a `workers.dev` URL, where a
 * hardcoded origin would silently be the wrong one again.
 */
function purge(ctx: ExecutionContext, request: Request): void {
  const { origin } = new URL(request.url)
  ctx.waitUntil(
    Promise.all(
      CACHED_READS.map(([path, variant]) =>
        caches.default.delete(cacheKey(new URL(`${origin}${path}`), variant)),
      ),
    ),
  )
}

/**
 * Drop one note's cached permalink variants after an edit or delete.
 *
 * These are addressed by id, so they can't sit in `CACHED_READS` (same reason
 * a deep page of `/notes.json` doesn't) — without this, an edited note's
 * permalink would keep showing the old text to a bot or a `curl` for up to
 * `EDGE_TTL` seconds after the edit.
 *
 * Unlike `purge()`, the origin here is hardcoded to `SITE` rather than taken
 * from the request: the permalink is only ever served on the apex zone
 * (`cailinpitt.com/notes/<id>`), never on this Worker's own `notes.…`
 * hostname, and a write typically *arrives* on the `notes.…` hostname — using
 * the request's origin here would purge a cache entry that was never made.
 */
function purgeNote(ctx: ExecutionContext, id: string): void {
  const bare = new URL(`${SITE}/notes/${id}`)
  // The JSON variant is only ever requested with ?format=json — unlike the
  // `?T` no-color option on the text views, that query string isn't an edge
  // case, it's the only way to reach this variant at all, so purging the bare
  // URL here would delete a cache entry that was never written under it.
  const jsonUrl = new URL(bare)
  jsonUrl.searchParams.set('format', 'json')

  ctx.waitUntil(
    Promise.all([
      caches.default.delete(cacheKey(jsonUrl, 'note-json')),
      caches.default.delete(cacheKey(bare, 'note-text')),
      caches.default.delete(cacheKey(bare, 'note-html')),
    ]),
  )
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

/**
 * Link-unfurl bots — the audience the permalink's static HTML exists for.
 * Most name themselves with "bot"/"crawler"/"spider"; the few that don't
 * (facebookexternalhit, WhatsApp, Pinterest's and Embedly's fetchers) are
 * listed by name. Best-effort by nature — a false negative just means that
 * client gets the 302 to the SPA instead of a page with meta tags in it.
 */
const BOT_AGENT =
  /bot|crawler|spider|facebookexternalhit|whatsapp|pinterest|embedly|quora link preview/i

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

// ---- the write path ------------------------------------------------------

/**
 * Read `text` (and, for JSON senders, an optional context reference) from
 * whichever shape the client found easiest to send.
 *
 * JSON is what the compose page posts, context included. The form and
 * plain-text shapes exist for Shortcuts, whose "Get Contents of URL" action
 * makes JSON awkward to build by hand but form fields trivial — the same
 * accommodation worker-photos makes, and for the same reason: the client that
 * is hardest to debug should have the easiest path. Neither of those sends a
 * context reference, which is fine — it is optional on every note.
 */
async function readPayload(
  request: Request,
): Promise<{ text: unknown; contextType?: unknown; contextRef?: unknown }> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()

  if (contentType.includes('application/json')) {
    const payload = (await request.json().catch(() => null)) as
      | { text?: unknown; contextType?: unknown; contextRef?: unknown }
      | null
    return { text: payload?.text, contextType: payload?.contextType, contextRef: payload?.contextRef }
  }
  if (
    contentType.includes('form-data') ||
    contentType.includes('application/x-www-form-urlencoded')
  ) {
    const form = await request.formData().catch(() => null)
    return { text: form?.get('text') ?? undefined }
  }
  // Anything else: the body itself is the note. `curl -d 'a thought'` lands here.
  return { text: await request.text().catch(() => '') }
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

  const checked = validate(await readPayload(request))
  if (!checked.ok) return jsonNoStore({ error: checked.error }, 400, cors)

  const note = await insertNote(env.DB, checked.value, checked.context)
  purge(ctx, request)
  log({ level: 'info', published: { id: note.id, length: [...note.text].length } })

  // The created row goes back so the client can show it immediately rather than
  // re-reading through a cache it just invalidated, and so a Shortcut can put
  // the permalink in its notification.
  return jsonNoStore({ ok: true, note, url: `${SITE}/notes/${note.id}` }, 201, cors)
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

  const checked = validate(await readPayload(request))
  if (!checked.ok) return jsonNoStore({ error: checked.error }, 400, cors)

  const note = await updateNote(env.DB, id, checked.value, checked.context)
  if (!note) return jsonNoStore({ id, error: 'no such note' }, 404, cors)
  purge(ctx, request)
  purgeNote(ctx, id)
  log({ level: 'info', edited: { id } })

  return jsonNoStore({ ok: true, note, url: `${SITE}/notes/${note.id}` }, 200, cors)
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
  if (removed) {
    purge(ctx, request)
    purgeNote(ctx, id)
  }
  log({ level: 'info', deleted: { id, removed } })

  return removed
    ? jsonNoStore({ id, deleted: true }, 200, cors)
    : jsonNoStore({ id, error: 'no such note' }, 404, cors)
}

// ---- the permalink ---------------------------------------------------------

/**
 * A note as a static page: real `<meta property="og:...">` tags, so a link
 * shared to Slack/Discord/iMessage/etc. unfurls the note's own text instead
 * of the generic feed card. No `og:image` — the site's OG cards are rendered
 * at build time (scripts/generate-og.mjs, using satori/sharp), neither of
 * which can run in a Worker, and a per-note image isn't worth reimplementing
 * that pipeline for. This page is for bots; a real browser never sees it —
 * see permalink() below.
 */
function noteHtml(note: Note): string {
  const heading = noteTitle(note.text)
  const description = note.text.replace(/\s+/g, ' ').trim()
  const permalink = `${SITE}/notes/${note.id}`
  const feedLink = `${SITE_NOTES}#${note.id}`

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeXml(heading)} — Cailin Pitt</title>`,
    `<meta name="description" content="${escapeXml(description)}">`,
    `<link rel="canonical" href="${escapeXml(permalink)}">`,
    '<meta property="og:type" content="article">',
    '<meta property="og:site_name" content="Cailin Pitt">',
    `<meta property="og:title" content="${escapeXml(heading)}">`,
    `<meta property="og:description" content="${escapeXml(description)}">`,
    `<meta property="og:url" content="${escapeXml(permalink)}">`,
    '<meta name="twitter:card" content="summary">',
    '</head>',
    '<body>',
    `<p>${escapeXml(note.text).replace(/\n/g, '<br>')}</p>`,
    `<p><a href="${escapeXml(feedLink)}">See it on cailinpitt.com/notes</a></p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/**
 * `cailinpitt.com/notes/<id>` — the permalink, rendered at the edge rather
 * than at deploy time so a note is addressable the moment it is published
 * (see the header of this file). Four audiences:
 *
 *   - `?format=json`: the site's own /notes page, resolving a permalink by id
 *     directly instead of paging through the whole feed looking for it.
 *   - curl/wget/etc: the same plain-text view the feed gets, for one note.
 *   - a link-unfurl bot (BOT_AGENT): noteHtml() above.
 *   - anyone else, i.e. a real browser: redirected to /notes#<id>, where the
 *     note lives inside the interactive feed. User-Agent dependent, so this
 *     one response can never be cached.
 */
async function permalink(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Record<string, string>,
  id: string,
  url: URL,
): Promise<Response> {
  if (url.searchParams.get('format') === 'json') {
    return await cached(url, 'note-json', ctx, cors, async () => {
      const note = await getNote(env.DB, id)
      return note ? json({ note }, EDGE_TTL) : jsonNoStore({ id, error: 'no such note' }, 404, cors)
    })
  }

  if (wantsText(request, url)) {
    return await cached(url, 'note-text', ctx, cors, async () => {
      const note = await getNote(env.DB, id)
      if (!note) return new Response('Not found', { status: 404, headers: cors })
      return cachedResponse(
        renderNoteText(note, {
          color: !url.searchParams.has('T'),
          offset: Number(env.TZ_OFFSET_SECONDS) || 0,
          site: SITE,
        }),
        'text/plain; charset=utf-8',
        EDGE_TTL,
      )
    })
  }

  if (BOT_AGENT.test(request.headers.get('user-agent') ?? '')) {
    return await cached(url, 'note-html', ctx, cors, async () => {
      const note = await getNote(env.DB, id)
      if (!note) return new Response('Not found', { status: 404, headers: cors })
      return cachedResponse(noteHtml(note), 'text/html; charset=utf-8', EDGE_TTL)
    })
  }

  return new Response(null, {
    status: 302,
    headers: { location: `${SITE_NOTES}#${id}`, 'cache-control': 'no-store', ...cors },
  })
}

// ---- worker --------------------------------------------------------------

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    const url = new URL(request.url)
    const single = url.pathname.match(/^\/notes\/([a-f0-9]{4,32})$/)
    try {
      // ---- cailinpitt.com/notes/* — the permalink -----------------------
      //
      // This Worker's route on the apex zone only ever sees paths already
      // scoped to /notes/* (see wrangler.jsonc), everything else on
      // cailinpitt.com is GitHub Pages. A path that isn't a note id — most
      // often /notes/compose, a real prerendered page — is passed straight
      // through: a same-zone fetch() bypasses Cloudflare's routing layer and
      // goes directly to the zone's configured origin, so this can't loop
      // back into the route that dispatched here.
      if (url.hostname === 'cailinpitt.com') {
        if (single && request.method === 'GET') {
          return await permalink(request, env, ctx, cors, single[1], url)
        }
        return fetch(request)
      }

      // ---- writes (PUBLISH_TOKEN only, never cached) ----

      if (url.pathname === '/notes' && request.method === 'POST') {
        return await publish(request, env, ctx, cors)
      }

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
