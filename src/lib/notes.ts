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

export interface Note {
  id: string
  text: string
  /** Unix seconds (UTC). */
  createdAt: number
  /** Unix seconds of the last edit, or null if it has never been edited. */
  editedAt: number | null
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

// ---- writes --------------------------------------------------------------

async function write(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  token: string,
  text?: string,
): Promise<{ note?: Note }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(text === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(text === undefined ? {} : { body: JSON.stringify({ text }) }),
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

export async function publishNote(text: string, token: string): Promise<Note> {
  const { note } = await write('/notes', 'POST', token, text)
  if (!note) throw new NoteError('The note was not returned.', 500)
  return note
}

export async function editNote(id: string, text: string, token: string): Promise<Note> {
  const { note } = await write(`/notes/${id}`, 'PATCH', token, text)
  if (!note) throw new NoteError('The note was not returned.', 500)
  return note
}

export async function removeNote(id: string, token: string): Promise<void> {
  await write(`/notes/${id}`, 'DELETE', token)
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

export type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; value: string; href: string }

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
 * A note split into plain text and links, ready to render as React elements.
 *
 * This is why notes can be plain text rather than Markdown: the only formatting
 * a 480-character thought actually needs is a clickable link, and doing that as
 * a data structure the page maps over means there is no HTML string anywhere in
 * the pipeline — no `dangerouslySetInnerHTML`, nothing to sanitize, and no way
 * for a note to contribute markup to the page.
 *
 * Pure and covered by tests/notes.test.ts.
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    // A match that is nothing but punctuation once trimmed isn't a link at all;
    // fall back to the raw match so no text is lost.
    const value = trimTrailing(match[0]) || match[0]

    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) })
    out.push({
      kind: 'link',
      value,
      href: value.startsWith('www.') ? `https://${value}` : value,
    })
    last = start + value.length
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
 * The absolute permalink for a note.
 *
 * An anchor on the feed rather than a page of its own — notes are not
 * prerendered, and GitHub Pages has no router to resolve `/notes/<id>` into
 * anything. See the note on this trade in worker-notes/src/index.ts.
 */
export const notePath = (id: string): string => `/notes#${id}`
