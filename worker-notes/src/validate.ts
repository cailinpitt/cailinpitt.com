// Input validation for the write endpoints. Unlike the guestbook's, this guards
// a token-gated endpoint (the only person it ever says no to is Cailin on her
// phone), so it's short: bound length, normalize whitespace, strip invisibles —
// no link limit or spam heuristic. Escaping is deliberately not handled here: a
// note renders as React text / plain text, not HTML; feed.ts escapes for RSS.

// Defined here rather than in store.ts and imported the other way: store.ts
// uses D1's ambient Workers types, unavailable to the site's own `tsc`, and
// tests/notes.test.ts imports this file — a type import from store.ts would
// drag D1Database into the site's type-check.
export type ContextType = 'photo' | 'activity' | 'post'

/** The two context fields together, or absent for an ordinary note. */
export interface NoteContext {
  type: ContextType
  ref: string
}

// Unicode code points, so an emoji counts as one character, matching the
// compose box's counter. Mirrored in src/lib/notes.ts and pinned by
// tests/notes-validate.test.ts so the two can't drift.
export const MAX_LENGTH = 480

/** The link a card should be built for, and whether its text was stripped from the note. */
export interface LinkFields {
  url: string | null
  hidden: boolean
}

export type Validation =
  | { ok: true; value: string; context: NoteContext | null; link: LinkFields }
  | { ok: false; error: string }

/** Code-point length. `'👋'.length` is 2; this counts it as 1. */
export const glyphs = (s: string): number => [...s].length

// Control (Cc) and format (Cf) characters — the bidi-override ones in Cf would
// let stored text render in an order it isn't stored in. Newline is Cc, so the
// replacer spares it explicitly.
const INVISIBLE = /\p{Cc}|\p{Cf}/gu

// NFC, newlines to `\n`, invisibles gone, trailing space per line trimmed, no
// more than one blank line in a row — the last is what keeps a stray paste of
// a hundred newlines from becoming three screens of nothing, since the feed has
// no per-note height limit by design.
export function clean(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, (c) => (c === '\n' ? c : ''))
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The only things a note is allowed to reference. */
const CONTEXT_TYPES = new Set<ContextType>(['photo', 'activity', 'post'])

/** A photo/activity id or a post path — generous, but not unbounded. */
const MAX_CONTEXT_REF = 200

// contextType and contextRef travel together, both present or both absent. One
// without the other is a client bug, refused rather than silently dropped.
function validateContext(
  rawType: unknown,
  rawRef: unknown,
): { ok: true; value: NoteContext | null } | { ok: false; error: string } {
  const hasType = typeof rawType === 'string' && rawType.length > 0
  const hasRef = typeof rawRef === 'string' && rawRef.length > 0

  if (!hasType && !hasRef) return { ok: true, value: null }
  if (!hasType || !CONTEXT_TYPES.has(rawType as ContextType)) {
    return { ok: false, error: 'That reference type is not one this site knows about.' }
  }
  if (!hasRef || (rawRef as string).length > MAX_CONTEXT_REF) {
    return { ok: false, error: 'A reference needs something to point at.' }
  }
  return { ok: true, value: { type: rawType as ContextType, ref: rawRef as string } }
}

// Same narrow shape as URL_RE in src/lib/notes.ts: a link card is only ever
// built for something the note's own autolinker would also have turned blue.
const LINK_URL_RE = /^(https?:\/\/[^\s<>]+|www\.[^\s<>]+)$/i

// linkHidden alone (no linkUrl) is refused, since there's nothing to hide.
// Deliberately not checked: whether rawUrl is still in `text` — index.ts's
// stripLink() deletes it once, so every edit after that legitimately lacks it.
function validateLink(
  rawUrl: unknown,
  rawHidden: unknown,
): { ok: true; value: LinkFields } | { ok: false; error: string } {
  const hidden = rawHidden === true

  if (rawUrl === undefined || rawUrl === null || rawUrl === '') {
    if (hidden) return { ok: false, error: 'A hidden link needs a link.' }
    return { ok: true, value: { url: null, hidden: false } }
  }
  if (typeof rawUrl !== 'string' || !LINK_URL_RE.test(rawUrl)) {
    return { ok: false, error: 'That does not look like a link.' }
  }
  return { ok: true, value: { url: rawUrl, hidden } }
}

export function validate(payload: unknown): Validation {
  const body = (payload ?? {}) as Record<string, unknown>
  const text = clean(body.text)

  if (!text) return { ok: false, error: 'A note needs some text in it.' }
  if (glyphs(text) > MAX_LENGTH) {
    return {
      ok: false,
      error: `That is ${glyphs(text)} characters — the limit is ${MAX_LENGTH}.`,
    }
  }

  const context = validateContext(body.contextType, body.contextRef)
  if (!context.ok) return context

  const link = validateLink(body.linkUrl, body.linkHidden)
  if (!link.ok) return link

  return { ok: true, value: text, context: context.value, link: link.value }
}
