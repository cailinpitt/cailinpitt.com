// No escaping here: comments render as React text nodes, so sanitizing input
// would only mangle honest messages.

export const LIMITS = {
  name: 60,
  message: 1000,
  website: 200,
} as const

const MAX_LINKS = 2

// Post paths come straight from frontmatter `path:` and aren't zero-padded
// (e.g. /blog/2026/8/1/some-slug, not /blog/2026/08/01/...).
const POST_PATH = /^\/blog\/\d{4}\/\d{1,2}\/\d{1,2}\/[a-z0-9-]+$/

export interface CleanComment {
  postPath: string
  name: string
  message: string
  website: string | null
}

export type Validation =
  | { ok: true; value: CleanComment }
  | { ok: false; field: keyof CleanComment; error: string }

const fail = (field: keyof CleanComment, error: string): Validation => ({
  ok: false,
  field,
  error,
})

const glyphs = (s: string) => [...s].length

const INVISIBLE = /\p{Cc}|\p{Cf}/gu

function clean(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, (c) => (c === '\n' ? c : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function countLinks(message: string): number {
  const matches = message.match(
    /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ru|cn|xyz|top|shop|link|click)\b/gi,
  )
  return matches?.length ?? 0
}

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
  return { ok: true, value: url.toString() }
}

export function validate(payload: unknown): Validation {
  const body = (payload ?? {}) as Record<string, unknown>

  const postPath = typeof body.postPath === 'string' ? body.postPath : ''
  if (!POST_PATH.test(postPath)) {
    return fail('postPath', "That doesn't look like a post.")
  }

  const name = clean(body.name)
  if (!name) return fail('name', 'A name (or a handle, or an alias) is required.')
  if (glyphs(name) > LIMITS.name) {
    return fail('name', `Keep the name under ${LIMITS.name} characters.`)
  }
  if (name.includes('\n')) return fail('name', 'The name should be a single line.')

  const message = clean(body.message)
  if (!message) return fail('message', 'A comment is required.')
  if (glyphs(message) > LIMITS.message) {
    return fail('message', `Keep the comment under ${LIMITS.message} characters.`)
  }
  if (countLinks(message) > MAX_LINKS) {
    return fail('message', 'That is a lot of links. Put your site in the website field instead.')
  }

  const website = cleanWebsite(body.website)
  if (!website.ok) return fail('website', website.error)

  return {
    ok: true,
    value: { postPath, name, message, website: website.value },
  }
}
