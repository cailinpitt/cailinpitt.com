// Notes API for cailinpitt.com/notes — the microblog. Unlike the guestbook
// (anyone can write, gated by a gauntlet), exactly one person can write here,
// gated by a bearer token, and a note is live the moment it's published — no
// build, no deploy, no commit. The permalink (see permalink() below) is
// rendered on demand at the edge rather than at build time so it's addressable
// immediately. Editing/deleting are first-class because publishing from a
// phone means publishing typos; an edit stamps `edited_at` rather than silently rewriting.

import { renderFeed, FEED_ITEMS, title as noteTitle, xml as escapeXml } from './feed'
import {
  deleteNote,
  getNote,
  insertNote,
  listAllHashtags,
  listNotes,
  listNotesBetween,
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

// Deliberately shorter than the settled-data endpoints elsewhere: the point of
// this feature is that a note appears immediately, and 30s still collapses a
// realistic traffic burst into one D1 query per colo.
const EDGE_TTL = 30

/** The site this Worker serves notes for. Links in the feed and curl view. */
const SITE = 'https://cailinpitt.com'
const SITE_NOTES = `${SITE}/notes`

// Any loopback port, so a dev server on 5174 instead of 5173 still works without
// editing wrangler.jsonc.
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

const allowedOrigins = (env: Env) => env.ALLOWED_ORIGIN.split(',').map((o) => o.trim())

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('origin') ?? ''
  return allowedOrigins(env).includes(origin) || LOOPBACK.test(origin)
}

// Writes are reachable from any origin, unlike the guestbook's: this endpoint is
// driven by an iOS Shortcut as much as the compose page (a share sheet has no
// origin at all), so an origin check would reject the primary client. The
// bearer token is the real security boundary here.
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin') ?? ''
  return {
    'access-control-allow-origin': originAllowed(request, env) ? origin : allowedOrigins(env)[0],
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    vary: 'origin',
  }
}

// The cached builders omit CORS: it varies by Origin and is applied by withCors()
// after the cache, so a cached entry stays origin-independent.

const cachedResponse = (body: string, contentType: string, maxAge: number): Response =>
  new Response(body, {
    headers: {
      'content-type': contentType,
      // max-age is what a browser holds, s-maxage what the edge holds — see the
      // site README's Caching section.
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

// Cloudflare doesn't cache Worker-generated responses on its own, so without
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

// Used by purge(). Variants must exactly match what the routes below pass to
// `cached()` — a typo here purges nothing and looks like nothing at all (how
// this went unnoticed once already). Only unparameterized paths appear: a deep
// page of older notes is addressed by cursor and unaffected by a new note.
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

// Without this, opening /notes on another device right after publishing could
// show a feed up to EDGE_TTL seconds stale. `origin` is taken from the incoming
// request, not hardcoded to `SITE` — it used to be, and since `cached()` keys by
// the request URL (`notes.cailinpitt.com`, not `cailinpitt.com`), every purge
// silently deleted nothing. Deriving it from the request makes the two agree by
// construction, on preview deploys too.
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

// Addressed by id, so these can't sit in CACHED_READS (same reason a deep page
// of /notes.json doesn't). Origin is hardcoded to SITE, unlike purge() — the
// permalink is only ever served on the apex zone, never this Worker's own
// `notes.…` hostname a write typically arrives on, so using the request's
// origin here would purge a cache entry that was never made.
function purgeNote(ctx: ExecutionContext, id: string): void {
  const bare = new URL(`${SITE}/notes/${id}`)
  // The JSON variant is only ever requested with ?format=json — that's the only
  // way to reach it, so purging the bare URL would miss it entirely.
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

// Constant-time comparison — the only thing standing between the internet and
// the microblog's contents; length may leak, contents may not.
function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (token.length !== secret.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i)
  return diff === 0
}

const CLI_AGENT = /^(curl|wget|httpie|HTTPie|xh|powershell|fetch)\b/i

function wantsText(request: Request, url: URL): boolean {
  if (url.searchParams.has('format') || url.searchParams.has('json')) return false
  return CLI_AGENT.test(request.headers.get('user-agent') ?? '')
}

// Link-unfurl bots — the audience the permalink's static HTML exists for. Most
// self-identify with "bot"/"crawler"/"spider"; the rest are listed by name.
// Best-effort: a false negative just gets the 302 to the SPA instead.
const BOT_AGENT =
  /bot|crawler|spider|facebookexternalhit|whatsapp|pinterest|embedly|quora link preview/i

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

// JSON is what the compose page posts, context included. Form and plain-text
// shapes exist for Shortcuts, whose "Get Contents of URL" action makes JSON
// awkward but form fields trivial — same accommodation worker-photos makes.
// Neither sends a context reference, which is fine since it's optional.
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

// Only the first occurrence — a URL pasted twice on purpose is content, not a
// formatting artifact to eat twice. Re-cleaned so no stray blank paragraph is left.
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

// Rendering needs satori/resvg/sharp, none of which run in a Worker — see
// scripts/generate-note-og.mjs. Failure here isn't a failed publish: the note
// is already live, it just goes out without a card image this time.
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

// Unresized — no sharp in a Worker, so unlike the site's own OG cards this
// stores whatever the source serves, capped by size. LinkCard.tsx handles the
// varying aspect ratios with `object-fit: cover`.
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

// Background half of a note's link card, kicked off from ctx.waitUntil in
// publish/edit. Runs entirely inside this Worker (see linkcard.ts), finishing
// in seconds rather than the ~1-2min a GitHub Actions run would take.
// Re-scrapes rather than trusting /notes/link-preview's last result, so the
// Worker stays the one source of truth. Best-effort like dispatchOgCard.
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

// Live, unstored scrape for the compose page to show a card while typing.
// Gated by PUBLISH_TOKEN — without it this would be an open fetch-anything
// proxy. Image is the source's own URL, not re-hosted (that would orphan an R2
// object for a link never published) — see buildLinkCard for the persisted version.
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

// A note as a static page with real og: meta tags, so a link shared to
// Slack/Discord/etc. unfurls the note's own text. og:image points at a card
// rendered async by .github/workflows/note-og.yml (dispatchOgCard) —
// referenced unconditionally since the R2 key is deterministic from the id; if
// the workflow hasn't finished, that URL just 404s. For bots only — see permalink() below.
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

// cailinpitt.com/notes/<id> — the permalink. Four audiences: ?format=json (the
// site's own /notes page resolving by id), curl/wget (plain text), a link-
// unfurl bot (noteHtml()), or a real browser (redirected to /notes#<id>).
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

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    const url = new URL(request.url)
    const single = url.pathname.match(/^\/notes\/([a-f0-9]{4,32})$/)
    const tagMatch = url.pathname.match(/^\/notes\/tag\/([A-Za-z0-9_][A-Za-z0-9_-]{0,49})\.json$/)
    try {
      // cailinpitt.com/notes/* — the permalink. This Worker's apex-zone route
      // only ever sees paths under /notes/* (see wrangler.jsonc); a path that
      // isn't a note id (e.g. /notes/compose) passes straight through — a
      // same-zone fetch() bypasses Cloudflare's routing layer and goes
      // directly to the zone's origin, so this can't loop back into itself.
      if (url.hostname === 'cailinpitt.com') {
        if (single && request.method === 'GET') {
          return await permalink(request, env, ctx, cors, single[1], url)
        }
        return fetch(request)
      }

      // Writes (PUBLISH_TOKEN only, never cached).
      if (url.pathname === '/notes' && request.method === 'POST') {
        return await publish(request, env, ctx, cors)
      }

      if (single && request.method === 'PATCH') {
        return await edit(request, env, ctx, cors, single[1])
      }
      if (single && request.method === 'DELETE') {
        return await remove(request, env, ctx, cors, single[1])
      }

      // Not edge-cached, unlike everything below — see linkPreviewRoute.
      if (url.pathname === '/notes/link-preview' && request.method === 'GET') {
        return await linkPreviewRoute(request, cors, env)
      }

      // Reads (public, edge-cached).
      if (url.pathname === '/notes.json') {
        if (url.searchParams.has('from') && url.searchParams.has('to')) {
          const from = Number(url.searchParams.get('from'))
          const to = Number(url.searchParams.get('to'))
          if (!Number.isFinite(from) || !Number.isFinite(to)) {
            return new Response('Bad range', { status: 400, headers: cors })
          }
          return await cached(url, 'between', ctx, cors, async () =>
            json({ notes: await listNotesBetween(env.DB, from, to) }, EDGE_TTL),
          )
        }
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

      // Unlike the per-tag route below, this is in CACHED_READS/purge() (one
      // well-known unparameterized path) so a new note's tags show up in the
      // cloud the moment the purge lands.
      if (url.pathname === '/notes/hashtags.json') {
        return await cached(url, 'hashtags', ctx, cors, async () =>
          json(await listAllHashtags(env.DB), EDGE_TTL),
        )
      }

      // Hashtags aren't a separate column (see hashtags.ts), so this is its own
      // query. Not in CACHED_READS/purge(): parameterized by tag, low traffic,
      // the edge TTL alone keeps it close enough.
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

      // Newest note, for the homepage strip — same shape as the other workers'
      // /now.json endpoints.
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

      // Served rather than duplicated, so the compose page's counter can't
      // disagree with validate.ts.
      if (url.pathname === '/limits.json') {
        return await cached(url, 'limits', ctx, cors, async () =>
          json({ maxLength: MAX_LENGTH, pageSize: PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE }, 86_400),
        )
      }

      // `curl notes.cailinpitt.com` → the terminal view; a browser on the same
      // path gets the redirect below instead.
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

      // Same paths in a browser: the real page, not a 404. 302 + no-store since
      // this is UA-dependent — a cached redirect could later break `curl` here.
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
