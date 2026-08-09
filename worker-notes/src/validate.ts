// Input validation for the write endpoints.
//
// Unlike the guestbook's, this one guards a token-gated endpoint — the only
// person it ever says no to is Cailin, typing on a phone. So it is short: bound
// the length, normalize the whitespace, and strip the invisibles. There is no
// link limit and no spam heuristic, because there is no stranger on the other
// end of it.
//
// Not handled here, deliberately: escaping. A note renders as React text nodes
// on the site and as plain text in the curl view, so a stored `<script>` is
// eighteen visible characters. The one place it would matter is the RSS feed,
// which escapes on the way out (see feed.ts).

/**
 * The cap, in Unicode code points — so an emoji counts as one character, not
 * two, which is the count the compose box shows and the only one a person would
 * recognize as correct.
 *
 * 480 rather than a round 500 because it is the number Cailin picked for what a
 * passing thought is allowed to be. It is enforced here, mirrored in
 * src/lib/notes.ts for the counter, and pinned by tests/notes-validate.test.ts
 * so the two cannot drift.
 */
export const MAX_LENGTH = 480

export type Validation =
  | { ok: true; value: string }
  | { ok: false; error: string }

/** Code-point length. `'👋'.length` is 2; this counts it as 1. */
export const glyphs = (s: string): number => [...s].length

/**
 * Control (Cc) and format (Cf) characters. Cc is the C0/C1 control range; Cf
 * covers the zero-width and bidi-override characters. Neither belongs in a note,
 * and the bidi ones would let stored text render in an order it isn't stored in.
 *
 * Newline is Cc, so the replacer has to spare it explicitly — a note is allowed
 * to have a line break in it.
 */
const INVISIBLE = /\p{Cc}|\p{Cf}/gu

/**
 * Normalize a note: NFC, newlines to `\n`, invisibles gone, trailing space per
 * line trimmed, and no more than one blank line in a row.
 *
 * The blank-line collapse is what keeps a stray paste of a hundred newlines from
 * becoming a note that is three screens of nothing — the feed has no per-note
 * height limit, by design, because a note is short.
 */
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
  return { ok: true, value: text }
}
