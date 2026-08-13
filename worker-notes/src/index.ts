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
  listAllHashtags,
  listNotes,
  listNotesByTag,
  setLinkCard,
  updateNote,
  MAX_PAGE_SIZE,
  PAGE_SIZE,
  type Note,
} from './store'
import { scrapeLink } from './linkcard'
import { renderNoteText, renderText, TEXT_ROWS } from './text'
import { clean, MAX_LENGTH, validate, type LinkFields } from './validate'

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
  ['/notes/hashtags.json', 'hashtags'],
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
async function readPayload(request: Request): Promise<{
  text: unknown
  contextType?: unknown
  contextRef?: unknown
  linkUrl?: unknown
  linkHidden?: unknown
}> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()

  if (contentType.includes('application/json')) {
    const payload = (await request.json().catch(() => null)) as
      | {
          text?: unknown
          contextType?: unknown
          contextRef?: unknown
          linkUrl?: unknown
          linkHidden?: unknown
        }
      | null
    return {
      text: payload?.text,
      contextType: payload?.contextType,
      contextRef: payload?.contextRef,
      linkUrl: payload?.linkUrl,
      linkHidden: payload?.linkHidden,
    }
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

/**
 * Delete a hidden link's own text from a note, once validate() has already
 * confirmed the link is really in there. Only the first occurrence — a URL
 * pasted twice on purpose is content, not a formatting artifact to eat twice.
 * Re-cleaned afterward so the deletion can't leave a stray blank paragraph.
 */
function stripLink(text: string, link: LinkFields): string {
  if (!link.hidden || !link.url) return text
  const at = text.indexOf(link.url)
  if (at === -1) return text
  return clean(text.slice(0, at) + text.slice(at + link.url.length))
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

  const text = stripLink(checked.value, checked.link)
  const note = await insertNote(env.DB, text, checked.context, checked.link)
  purge(ctx, request)
  ctx.waitUntil(dispatchOgCard(env, note.id))
  if (checked.link.url) ctx.waitUntil(buildLinkCard(env, ctx, request, note.id, checked.link.url))
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

  const text = stripLink(checked.value, checked.link)
  const note = await updateNote(env.DB, id, text, checked.context, checked.link)
  if (!note) return jsonNoStore({ id, error: 'no such note' }, 404, cors)
  purge(ctx, request)
  purgeNote(ctx, id)
  ctx.waitUntil(dispatchOgCard(env, id))
  if (checked.link.url) ctx.waitUntil(buildLinkCard(env, ctx, request, id, checked.link.url))
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

/**
 * Ask GitHub to render this note's OG card (.github/workflows/note-og.yml).
 * Rendering needs satori/resvg/sharp, none of which run in a Worker — see
 * scripts/generate-note-og.mjs. A failure here is not a failed publish: the
 * note is already live, and just goes out without a card image this time.
 */
async function dispatchOgCard(env: Env, id: string): Promise<void> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return
  try {
    await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'cailinpitt-notes-worker',
      },
      body: JSON.stringify({ event_type: 'note-published', client_payload: { id } }),
    })
  } catch {
    /* see comment above — nothing to do here */
  }
}

/** Above the size a link's own image is worth re-hosting as-is; past this, skip the image and keep the text. */
const MAX_LINK_IMAGE_BYTES = 6_000_000

/**
 * Fetch a link's image and write it to R2 under this note's id, unresized —
 * there's no sharp in a Worker, so unlike the site's own OG cards this
 * stores whatever the source serves, capped by size rather than normalized.
 * `LinkCard.tsx` on the client handles the varying aspect ratios with
 * `object-fit: cover`. Returns whether it worked.
 */
async function storeLinkImage(env: Env, id: string, imageUrl: string): Promise<boolean> {
  const res = await fetch(imageUrl, {
    signal: AbortSignal.timeout(8000),
    headers: { 'user-agent': 'cailinpitt.com-link-card/1.0 (+https://cailinpitt.com)' },
  })
  const contentType = res.headers.get('content-type') ?? ''
  if (!res.ok || !res.body || !contentType.startsWith('image/')) return false

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total > MAX_LINK_IMAGE_BYTES) {
      reader.cancel().catch(() => {})
      return false
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }

  await env.IMAGES.put(`og/links/${id}`, bytes, { httpMetadata: { contentType } })
  return true
}

/**
 * Scrapes a link, re-hosts its image, and persists the result — the
 * background half of a note's link card, kicked off from `ctx.waitUntil` in
 * publish/edit above. Runs entirely inside this Worker (see linkcard.ts's
 * header for why that's possible here but not for the site's own rendered
 * cards), so this typically finishes in a couple of seconds rather than the
 * ~1–2 minutes a GitHub Actions run would take.
 *
 * Re-scrapes rather than trusting whatever `/notes/link-preview` last
 * returned to the compose page: this is what actually gets persisted and
 * shown to every reader, so the Worker stays the one source of truth for it,
 * the same way it already is for everything else a note stores.
 *
 * Best-effort like dispatchOgCard: a failure here is not a failed publish,
 * the note is already live, and it just goes out without a card this time.
 */
async function buildLinkCard(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  id: string,
  url: string,
): Promise<void> {
  try {
    const preview = await scrapeLink(url)
    const imageReady = preview.image ? await storeLinkImage(env, id, preview.image) : false
    await setLinkCard(env.DB, id, {
      title: preview.title,
      description: preview.description,
      imageReady,
    })
    // Both, not just purgeNote: the card needs to show up in the feed
    // (/notes.json) the moment it's ready, not only on the permalink.
    purge(ctx, request)
    purgeNote(ctx, id)
    log({ level: 'info', linkCard: { id } })
  } catch (err) {
    log({ level: 'error', linkCard: { id, error: String(err) } })
  }
}

/**
 * `GET /notes/link-preview?url=<url>` — a live, unstored scrape for the
 * compose page to show a card *while typing*, before anything is published.
 * Gated by PUBLISH_TOKEN like every other write: the compose page is the
 * only realistic caller, and without the gate this would be an open
 * fetch-anything-and-return-it proxy. The image here is the source's own
 * URL, not re-hosted — re-hosting a link that's never actually published
 * would just be an orphaned R2 object; see buildLinkCard for the persisted,
 * re-hosted version that runs after a real publish.
 */
async function linkPreviewRoute(
  request: Request,
  cors: Record<string, string>,
  env: Env,
): Promise<Response> {
  if (!authorized(request, env.PUBLISH_TOKEN)) {
    return jsonNoStore({ error: 'unauthorized' }, 401, cors)
  }
  const url = new URL(request.url).searchParams.get('url')
  if (!url) return jsonNoStore({ error: 'A link needs a link.' }, 400, cors)

  try {
    const preview = await scrapeLink(url)
    return jsonNoStore(preview, 200, cors)
  } catch (err) {
    return jsonNoStore({ error: String(err) }, 502, cors)
  }
}

// ---- the permalink ---------------------------------------------------------

/**
 * A note as a static page: real `<meta property="og:...">` tags, so a link
 * shared to Slack/Discord/iMessage/etc. unfurls the note's own text instead
 * of the generic feed card. `og:image` points at a card rendered
 * asynchronously by .github/workflows/note-og.yml (dispatchOgCard above) —
 * referenced unconditionally, since the R2 key is deterministic from the id.
 * If the workflow hasn't finished yet, that URL 404s and the crawler just
 * renders without a thumbnail. This page is for bots; a real browser never
 * sees it — see permalink() below.
 */
function noteHtml(note: Note): string {
  const heading = noteTitle(note.text)
  const description = note.text.replace(/\s+/g, ' ').trim()
  const permalink = `${SITE}/notes/${note.id}`
  const feedLink = `${SITE_NOTES}#${note.id}`
  const image = `https://images.cailinpitt.com/og/notes/${note.id}.jpg`

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
    `<meta property="og:image" content="${escapeXml(image)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
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
    const tagMatch = url.pathname.match(/^\/notes\/tag\/([A-Za-z0-9_][A-Za-z0-9_-]{0,49})\.json$/)
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

      // Not edge-cached, unlike everything below: this is a live scrape of
      // whatever URL was asked for, called from the compose page while
      // typing (see linkPreviewRoute's own comment).
      if (url.pathname === '/notes/link-preview' && request.method === 'GET') {
        return await linkPreviewRoute(request, cors, env)
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

      // Every hashtag ever used, for "browse by tag" on /notes — unlike the
      // per-tag route below, this *is* in CACHED_READS/purge() (unparameterized,
      // one well-known path) so a new note's tags show up in the cloud the
      // moment the purge lands, same as the note itself does in /notes.json.
      if (url.pathname === '/notes/hashtags.json') {
        return await cached(url, 'hashtags', ctx, cors, async () =>
          json(await listAllHashtags(env.DB), EDGE_TTL),
        )
      }

      // A note's hashtags aren't a separate column — see hashtags.ts — so
      // this is its own query rather than a filter over /notes.json, and it
      // isn't in CACHED_READS/purge() for the same reason a deep page of
      // /notes.json isn't: parameterized by tag, low traffic, the edge TTL
      // alone is enough to keep it from ever being far behind.
      if (tagMatch) {
        return await cached(url, `tag:${tagMatch[1]}`, ctx, cors, async () =>
          json(
            await listNotesByTag(env.DB, tagMatch[1].toLowerCase(), {
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
