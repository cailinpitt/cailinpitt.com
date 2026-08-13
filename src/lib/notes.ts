// Client for the notes API (the Cloudflare Worker in /worker-notes) — the
// microblog behind /notes.
//
// Like /listening, /reading, and /guestbook, the page is prerendered as a static
// shell and fetches this in the browser. Unlike those, this module also carries
// the *write* path: publishing, editing, and deleting, all bearer-token gated
// and driven from /notes/compose.
//
// These interfaces mirror the Worker's by hand — the two aren't a shared
// package, so a change on one side has to be made on the other.

const API_BASE = import.meta.env.VITE_NOTES_API ?? 'https://notes.cailinpitt.com'

/**
 * The apex site's own origin — where the permalink route lives
 * (cailinpitt.com/notes/<id>, not notes.cailinpitt.com/...; see the header of
 * worker-notes/src/index.ts). Same pattern as SITE_URL in Seo.tsx/structuredData.ts.
 */
const SITE_URL = 'https://cailinpitt.com'

/** The feed's own RSS, served by the Worker rather than written at build time. */
export const NOTES_FEED_URL = `${API_BASE}/feed.xml`

/**
 * Mirrors MAX_LENGTH in worker-notes/src/validate.ts. Used for the compose
 * box's counter and its client-side guard.
 *
 * Duplicated rather than fetched because the counter has to be right on the
 * first keystroke, before any request could have landed. `tests/notes.test.ts`
 * pins this against the Worker's copy so the two cannot drift.
 */
export const MAX_LENGTH = 480

/** What a note can reference: another content type's own id space. */
export type ContextType = 'photo' | 'activity' | 'post'

/** The two context fields together, for publishing/editing with a reference. */
export interface NoteContext {
  type: ContextType
  ref: string
}

export interface Note {
  id: string
  text: string
  /** Unix seconds (UTC). */
  createdAt: number
  /** Unix seconds of the last edit, or null if it has never been edited. */
  editedAt: number | null
  /** What this note is about, if anything. Always paired with contextRef. */
  contextType: ContextType | null
  /** The referenced thing's own id (a photo id, an activity id, a post path). */
  contextRef: string | null
  /** The link a card is attached to, if any. */
  linkUrl: string | null
  /** Whether linkUrl's own text was deleted from `text` when it was set. */
  linkHidden: boolean
  /** Filled in asynchronously, shortly after publish/edit — null until it's done. */
  linkTitle: string | null
  linkDescription: string | null
  /** Whether a re-hosted copy of the link's image exists yet (see linkCardImageUrl). */
  linkImageReady: boolean
}

/** The link fields a publish/edit can send, mirroring LinkFields in worker-notes/src/validate.ts. */
export interface NoteLink {
  url: string
  hidden: boolean
}

export interface NotePage {
  notes: Note[]
  /** Opaque; pass straight back to fetchOlderNotes. Null means no more. */
  nextCursor: string | null
  total: number
}

export interface NotesNow {
  latest: Note | null
  total: number
}

/** A rejected write. `status` distinguishes a bad token from a bad note. */
export class NoteError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'NoteError'
    this.status = status
  }
}

// ---- reads ---------------------------------------------------------------

export async function fetchNotes(signal?: AbortSignal): Promise<NotePage> {
  const res = await fetch(`${API_BASE}/notes.json`, { signal })
  if (!res.ok) throw new Error(`Notes API ${res.status}`)
  return res.json() as Promise<NotePage>
}

export async function fetchOlderNotes(
  cursor: string,
  limit = 25,
  signal?: AbortSignal,
): Promise<NotePage> {
  const res = await fetch(
    `${API_BASE}/notes.json?before=${encodeURIComponent(cursor)}&limit=${limit}`,
    { signal },
  )
  if (!res.ok) throw new Error(`Notes API ${res.status}`)
  return res.json() as Promise<NotePage>
}

/** The newest note alone, for the homepage strip. */
export async function fetchNotesNow(signal?: AbortSignal): Promise<NotesNow> {
  const res = await fetch(`${API_BASE}/now.json`, { signal })
  if (!res.ok) throw new Error(`Notes API ${res.status}`)
  return res.json() as Promise<NotesNow>
}

export interface HashtagSummary {
  tag: string
  count: number
}

/** Every hashtag ever used, most-used first — the "browse by tag" cloud on /notes. */
export async function fetchNoteHashtags(signal?: AbortSignal): Promise<HashtagSummary[]> {
  const res = await fetch(`${API_BASE}/notes/hashtags.json`, { signal })
  if (!res.ok) throw new Error(`Notes API ${res.status}`)
  return res.json() as Promise<HashtagSummary[]>
}

/** Every note tagged `#tag`, newest first — the feed for /notes/tag/:tag. */
export async function fetchNotesByTag(
  tag: string,
  cursor?: string | null,
  limit = 25,
  signal?: AbortSignal,
): Promise<NotePage> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('before', cursor)
  const res = await fetch(`${API_BASE}/notes/tag/${encodeURIComponent(tag)}.json?${params}`, { signal })
  if (!res.ok) throw new Error(`Notes API ${res.status}`)
  return res.json() as Promise<NotePage>
}

/**
 * One note, resolved directly by id — a call to the permalink route
 * (`?format=json` is how it asks for JSON rather than the HTML or redirect a
 * browser or a bot would get; see worker-notes/src/index.ts). `null` means
 * the id doesn't exist (or was deleted), not a network failure — a failure
 * still throws.
 *
 * Always the real cailinpitt.com origin, never a relative path: the
 * permalink route only exists on the apex zone, which is only the *page's*
 * own origin when the page is actually being served from cailinpitt.com. In
 * dev (localhost:5173) or on a preview deploy, a relative fetch would resolve
 * against the wrong origin and 404 there instead. The Worker's CORS already
 * allows any localhost/127.0.0.1 origin (see corsHeaders() in
 * worker-notes/src/index.ts), so this works cross-origin in dev without
 * needing a local Worker running.
 */
export async function fetchNote(id: string, signal?: AbortSignal): Promise<Note | null> {
  const res = await fetch(`${SITE_URL}/notes/${id}?format=json`, { signal })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Notes API ${res.status}`)
  const { note } = (await res.json()) as { note: Note }
  return note
}

// ---- writes --------------------------------------------------------------

async function write(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  token: string,
  text?: string,
  context?: NoteContext | null,
  link?: NoteLink | null,
): Promise<{ note?: Note }> {
  const body =
    text === undefined
      ? undefined
      : {
          text,
          contextType: context?.type,
          contextRef: context?.ref,
          linkUrl: link?.url,
          linkHidden: link?.hidden,
        }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; note?: Note; error?: string }
    | null

  if (!res.ok) {
    throw new NoteError(
      data?.error ??
        (res.status === 401
          ? 'That token was not accepted.'
          : 'Something went wrong. Try again in a moment.'),
      res.status,
    )
  }
  return data ?? {}
}

export async function publishNote(
  text: string,
  token: string,
  context?: NoteContext | null,
  link?: NoteLink | null,
): Promise<Note> {
  const { note } = await write('/notes', 'POST', token, text, context, link)
  if (!note) throw new NoteError('The note was not returned.', 500)
  return note
}

export async function editNote(
  id: string,
  text: string,
  token: string,
  context?: NoteContext | null,
  link?: NoteLink | null,
): Promise<Note> {
  const { note } = await write(`/notes/${id}`, 'PATCH', token, text, context, link)
  if (!note) throw new NoteError('The note was not returned.', 500)
  return note
}

export async function removeNote(id: string, token: string): Promise<void> {
  await write(`/notes/${id}`, 'DELETE', token)
}

export interface LinkPreview {
  title: string | null
  description: string | null
  /** The source's own image URL — this is a live, unstored preview; nothing is re-hosted until publish. */
  image: string | null
}

/**
 * A live, on-demand scrape of `url` — what /notes/compose calls (debounced)
 * as soon as a link is detected, so a card shows up while composing rather
 * than only after publishing. `null` on any failure: this is preview UX, not
 * something worth surfacing as an error while someone is mid-thought.
 */
export async function fetchLinkPreview(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<LinkPreview | null> {
  try {
    const res = await fetch(`${API_BASE}/notes/link-preview?url=${encodeURIComponent(url)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    })
    if (!res.ok) return null
    return (await res.json()) as LinkPreview
  } catch {
    return null
  }
}

// ---- the publish token ---------------------------------------------------

const TOKEN_KEY = 'notes-publish-token'

/**
 * The publish token, kept in localStorage so it is pasted once per device
 * rather than once per note.
 *
 * This is a real trade and worth being clear about: a token in localStorage is
 * readable by any script running on cailinpitt.com. The site ships no
 * third-party JavaScript and has no user-generated HTML, so the realistic threat
 * is a stolen or borrowed laptop rather than an injection — and against that,
 * `forgetToken()` below and rotating the Worker secret are the answers. The
 * alternative, typing 64 hex characters on a phone every time, would mean the
 * compose page never got used.
 */
export function loadToken(): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function saveToken(token: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(TOKEN_KEY, token)
}

export function forgetToken(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(TOKEN_KEY)
}

// ---- presentation --------------------------------------------------------

/** Code-point length — `'👋'.length` is 2, this counts it as 1. Matches the Worker. */
export const glyphs = (s: string): number => [...s].length

/** Where a link's re-hosted card image lives, once linkImageReady is true. No extension — see worker-notes/src/index.ts's storeLinkImage. */
export const linkCardImageUrl = (id: string): string => `https://images.cailinpitt.com/og/links/${id}`

export type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; value: string; href: string }
  | { kind: 'hashtag'; value: string; tag: string }

/**
 * Bare URLs in a note. Deliberately narrow: an explicit http(s) scheme, or a
 * `www.` host. Notes are plain text, so anything cleverer (a scheme-less
 * `example.com/thing`) would start turning ordinary sentences that happen to
 * contain a period into links.
 *
 * Parentheses are *inside* the match rather than excluded from it, because they
 * are inside plenty of real URLs — `…/wiki/Tag_(2018_film)` is the canonical
 * example, and excluding them silently truncates the link to a 404. Sorting out
 * which trailing bracket belongs to the URL and which to the sentence around it
 * is `trimTrailing` below, not the pattern.
 */
const URL_RE = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/gi

/** Punctuation that ends a sentence rather than a URL. */
const TRAILING = /[.,;:!?'"]+$/

/**
 * Give back the characters at the end of a match that belong to the prose rather
 * than to the URL: sentence punctuation, and any closing bracket with no opener
 * inside the URL itself.
 *
 * Counting rather than just checking for a `(` is what separates
 * `(https://example.com)` — where the paren is the sentence's — from
 * `https://en.wikipedia.org/wiki/Tag_(2018_film)`, where it is the URL's. The
 * loop runs to a fixed point because the two rules feed each other: `…com).`
 * needs the stop trimmed before the bracket is on the end to be judged.
 */
function trimTrailing(url: string): string {
  let current = url
  for (;;) {
    const stripped = current.replace(TRAILING, '')
    const unbalanced =
      stripped.endsWith(')') &&
      stripped.split(')').length > stripped.split('(').length
    const next = unbalanced ? stripped.slice(0, -1) : stripped
    if (next === current) return current
    current = next
  }
}

/**
 * `#word` tokens. Must start right after a non-word/non-`#` boundary, so a
 * URL's own fragment (`…#section`) and a stray `##` don't turn into tags —
 * the overlap check in segments() below is belt-and-suspenders for the same
 * thing, since a URL match can itself contain a `#`.
 */
const HASHTAG_RE = /(?<![\w#])#(\w[\w-]{0,49})/g

interface Span {
  start: number
  end: number
  segment: Segment
}

/**
 * A note split into plain text, links, and hashtags, ready to render as React
 * elements.
 *
 * This is why notes can be plain text rather than Markdown: the only formatting
 * a 480-character thought actually needs is a clickable link (or tag), and doing
 * that as a data structure the page maps over means there is no HTML string
 * anywhere in the pipeline — no `dangerouslySetInnerHTML`, nothing to sanitize,
 * and no way for a note to contribute markup to the page.
 *
 * Pure and covered by tests/notes.test.ts.
 */
export function segments(text: string): Segment[] {
  const spans: Span[] = []

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    // A match that is nothing but punctuation once trimmed isn't a link at all;
    // fall back to the raw match so no text is lost.
    const value = trimTrailing(match[0]) || match[0]
    spans.push({
      start,
      end: start + value.length,
      segment: { kind: 'link', value, href: value.startsWith('www.') ? `https://${value}` : value },
    })
  }

  for (const match of text.matchAll(HASHTAG_RE)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    // A `#` that's part of a URL (a fragment) belongs to the link, not to this.
    if (spans.some((span) => start < span.end && end > span.start)) continue
    spans.push({ start, end, segment: { kind: 'hashtag', value: match[0], tag: match[1].toLowerCase() } })
  }

  spans.sort((a, b) => a.start - b.start)

  const out: Segment[] = []
  let last = 0
  for (const span of spans) {
    if (span.start > last) out.push({ kind: 'text', value: text.slice(last, span.start) })
    out.push(span.segment)
    last = span.end
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}

/**
 * A note's paragraphs, split on blank lines. The Worker has already collapsed
 * runs of three or more newlines to two, so this can't produce empty paragraphs
 * from stored text.
 */
export const paragraphs = (text: string): string[] =>
  text.split(/\n{2,}/).filter((para) => para.trim().length > 0)

/**
 * Where a note lives inside the SPA: an anchor on the feed rather than a
 * route, so following one is an instant client-side jump rather than a round
 * trip through the Worker. Not the address to *share* — see noteUrl below.
 */
export const notePath = (id: string): string => `/notes#${id}`

/**
 * The real, externally-shareable permalink — served by worker-notes at the
 * edge (see the header of worker-notes/src/index.ts) rather than baked in at
 * build time, so a note is addressable the moment it's published. This is
 * what unfurls properly when shared: a bot gets a page with the note's own
 * meta tags, a browser is bounced to notePath(id) above.
 *
 * `origin` defaults to the page's own, same as the inline
 * `window.location.origin` this replaces in ShareButton — parameterized so
 * this stays callable (and testable) outside a browser, the same guard
 * loadToken/saveToken use for localStorage.
 */
export function noteUrl(id: string, origin?: string): string {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  return `${base}/notes/${id}`
}
