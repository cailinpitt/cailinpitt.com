// Input validation for POST /entries.
//
// Everything a stranger can type passes through here before it reaches D1. The
// rules are deliberately boring: bound the length, strip the characters that
// only ever show up in spam or break the layout, and refuse a website that
// isn't an ordinary http(s) address.
//
// Not handled here, because it doesn't need to be: escaping. The page renders
// entries as React text nodes and the curl view writes them as plain text, so
// there is no context in which a stored `<script>` is anything but eleven
// visible characters. Sanitizing on input would only mangle honest messages.

/** Caps, in Unicode code points (so an emoji counts as one, not two). */
export const LIMITS = {
  name: 60,
  message: 1000,
  location: 60,
  website: 200,
} as const

/** How many links a message may contain before it reads as advertising. */
const MAX_LINKS = 2

export interface CleanEntry {
  name: string
  message: string
  website: string | null
  location: string | null
}

export type Validation =
  | { ok: true; value: CleanEntry }
  /** `field` lets the form show the message inline instead of in a banner. */
  | { ok: false; field: keyof CleanEntry; error: string }

const fail = (field: keyof CleanEntry, error: string): Validation => ({ ok: false, field, error })

/** Code-point length. `'👋'.length` is 2; this counts it as 1. */
const glyphs = (s: string) => [...s].length

/**
 * Control (Cc) and format (Cf) characters. Cc is the C0/C1 control range; Cf
 * covers the zero-width and bidi-override characters, which are the standard
 * way to hide a word from a filter or to make text render in an order it isn't
 * stored in. Neither category has any business in a guestbook entry.
 *
 * Newline survives — it is Cc, so the replacer has to spare it explicitly.
 */
const INVISIBLE = /\p{Cc}|\p{Cf}/gu

/**
 * Normalize one user string: NFC (so visually identical names compare equal),
 * newlines to `\n`, invisibles gone, and no more than one blank line in a row —
 * otherwise a single entry could push the rest of the guestbook off the screen.
 */
function clean(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, (c) => (c === '\n' ? c : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Counts things a reader would see as a link, including scheme-less ones. */
function countLinks(message: string): number {
  const matches = message.match(
    /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ru|cn|xyz|top|shop|link|click)\b/gi,
  )
  return matches?.length ?? 0
}

/**
 * A website field, normalized to a URL we're willing to render as a link.
 *
 * Bare `example.com` is upgraded to `https://example.com` — people type it that
 * way and rejecting it would be pedantic. Everything else is refused: a scheme
 * other than http(s) (`javascript:`, `data:`), a host with no dot, and
 * credentials in the URL (`https://paypal.com@evil.example`, which renders
 * misleadingly).
 */
function cleanWebsite(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = clean(raw).replace(/\s+/g, '')
  if (!text) return { ok: true, value: null }
  if (glyphs(text) > LIMITS.website) {
    return { ok: false, error: `Keep the website under ${LIMITS.website} characters.` }
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, error: "That doesn't look like a web address." }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https addresses, please.' }
  }
  if (url.username || url.password) {
    return { ok: false, error: "That doesn't look like a web address." }
  }
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) {
    return { ok: false, error: "That doesn't look like a web address." }
  }
  // Re-serialize rather than storing what was typed: this is what makes the
  // stored value predictable (scheme present, host lowercased, spaces encoded).
  return { ok: true, value: url.toString() }
}

export function validate(payload: unknown): Validation {
  const body = (payload ?? {}) as Record<string, unknown>

  const name = clean(body.name)
  if (!name) return fail('name', 'A name (or a handle, or an alias) is required.')
  if (glyphs(name) > LIMITS.name) {
    return fail('name', `Keep the name under ${LIMITS.name} characters.`)
  }
  // A name is one line. Someone pasting a paragraph into it is either confused
  // or probing, and either way the entry list can't lay it out.
  if (name.includes('\n')) return fail('name', 'The name should be a single line.')

  const message = clean(body.message)
  if (!message) return fail('message', 'A message is required.')
  if (glyphs(message) > LIMITS.message) {
    return fail('message', `Keep the message under ${LIMITS.message} characters.`)
  }
  if (countLinks(message) > MAX_LINKS) {
    return fail('message', 'That is a lot of links. Put your site in the website field instead.')
  }

  const location = clean(body.location).replace(/\n/g, ' ')
  if (glyphs(location) > LIMITS.location) {
    return fail('location', `Keep the location under ${LIMITS.location} characters.`)
  }

  const website = cleanWebsite(body.website)
  if (!website.ok) return fail('website', website.error)

  return {
    ok: true,
    value: { name, message, website: website.value, location: location || null },
  }
}
