// Client for the notes API (Cloudflare Worker in /worker-notes) — the microblog behind
// /notes. Also carries the write path (publish/edit/delete), bearer-token gated and driven
// from /notes/compose. Interfaces mirror the Worker's by hand — not a shared package.

const API_BASE = import.meta.env.VITE_NOTES_API ?? 'https://notes.cailinpitt.com'

// The apex origin, where the permalink route lives (cailinpitt.com/notes/<id>, not
// notes.cailinpitt.com/...). Same pattern as SITE_URL in Seo.tsx/structuredData.ts.
const SITE_URL = 'https://cailinpitt.com'

/** The feed's own RSS, served by the Worker rather than written at build time. */
export const NOTES_FEED_URL = `${API_BASE}/feed.xml`

// Mirrors MAX_LENGTH in worker-notes/src/validate.ts. Duplicated (not fetched) because the
// counter must be right on the first keystroke; tests/notes.test.ts pins the two together.
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

export async function fetchNotesOnDate(
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<Note[]> {
  const res = await fetch(`${API_BASE}/notes.json?from=${from}&to=${to}`, { signal })
  if (!res.ok) throw new Error(`Notes API ${res.status}`)
  const data = (await res.json()) as { notes: Note[] }
  return data.notes
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

// One note by id, via the permalink route (`?format=json` asks for JSON instead of the
// HTML/redirect a browser or bot gets). `null` means the id doesn't exist; a real failure
// still throws. Always SITE_URL, never a relative path — the permalink route only exists on
// the apex zone, and dev/preview origins would 404 there. Worker CORS allows localhost, so
// this works cross-origin in dev without a local Worker.
export async function fetchNote(id: string, signal?: AbortSignal): Promise<Note | null> {
  const res = await fetch(`${SITE_URL}/notes/${id}?format=json`, { signal })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Notes API ${res.status}`)
  const { note } = (await res.json()) as { note: Note }
  return note
}

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

// On-demand scrape of `url`, called (debounced) by /notes/compose as soon as a link is
// detected. `null` on any failure — preview UX, not worth surfacing as an error mid-thought.
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

const TOKEN_KEY = 'notes-publish-token'

// Kept in localStorage so it's pasted once per device, not once per note. Readable by any
// script on cailinpitt.com, but the site ships no third-party JS or user HTML, so the
// realistic threat is a stolen laptop, not injection — forgetToken()/secret rotation cover that.
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

/** Code-point length — `'👋'.length` is 2, this counts it as 1. Matches the Worker. */
export const glyphs = (s: string): number => [...s].length

/** Where a link's re-hosted card image lives, once linkImageReady is true. No extension — see worker-notes/src/index.ts's storeLinkImage. */
export const linkCardImageUrl = (id: string): string => `https://images.cailinpitt.com/og/links/${id}`

export type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; value: string; href: string }
  | { kind: 'hashtag'; value: string; tag: string }

// Bare URLs: an explicit http(s) scheme, or a `www.` host — nothing scheme-less, or ordinary
// sentences with periods would start matching. Parens stay inside the match (real URLs like
// `…/wiki/Tag_(2018_film)` need them); trimTrailing below sorts out which bracket is whose.
const URL_RE = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/gi

/** Punctuation that ends a sentence rather than a URL. */
const TRAILING = /[.,;:!?'"]+$/

// Strips trailing chars that belong to the prose, not the URL: sentence punctuation, and any
// closing bracket with no opener inside the URL. Runs to a fixed point since `…com).` needs
// the stop trimmed before the bracket can be judged.
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

// `#word` tokens, must follow a non-word/non-`#` boundary so a URL fragment (`…#section`) or
// stray `##` don't match — the overlap check in segments() below backstops the same thing.
const HASHTAG_RE = /(?<![\w#])#(\w[\w-]{0,49})/g

interface Span {
  start: number
  end: number
  segment: Segment
}

// A note split into plain text, links, and hashtags, ready to render as React elements — no
// HTML string in the pipeline, so no dangerouslySetInnerHTML or sanitizing. Pure, tested in tests/notes.test.ts.
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

// Split on blank lines; the Worker already collapses 3+ newlines to two, so no empty paragraphs.
export const paragraphs = (text: string): string[] =>
  text.split(/\n{2,}/).filter((para) => para.trim().length > 0)

// An anchor on the feed, not a route, so following one is an instant client-side jump.
// Not the address to *share* — see noteUrl below.
export const notePath = (id: string): string => `/notes#${id}`

// The real, externally-shareable permalink, served by worker-notes at the edge rather than
// baked in at build time, so a note is addressable the moment it's published — a bot gets
// meta tags, a browser is bounced to notePath(id). `origin` is parameterized so this stays testable outside a browser.
export function noteUrl(id: string, origin?: string): string {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  return `${base}/notes/${id}`
}
