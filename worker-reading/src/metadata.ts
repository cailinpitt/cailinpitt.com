// Pull an article's social-card metadata (title, image, description, site) out
// of its HTML with HTMLRewriter (native to Workers, streaming, no dependency).
//
// Best-effort throughout: a page with no OpenGraph tags, a bot-filter 403, or a
// slow origin must still leave the article loggable, via fallbacks (hostname
// for `site`, <title> for `title`).

/** Give up rather than hold the request open on a slow origin. */
const TIMEOUT_MS = 8_000

/** Cap on the HTML actually consumed. Everything we want is in <head>. */
const MAX_BYTES = 512 * 1024

export interface PageMetadata {
  title: string | null
  image: string | null
  excerpt: string | null
  site: string | null
}

/** Caps, so a page can't put a 300-character "title" on a card. */
const MAX_TITLE = 200
const MAX_EXCERPT = 400
const MAX_SITE = 60

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

// HTMLRewriter's getAttribute() returns raw source text, so entities in
// `content="…"` survive verbatim (e.g. Instagram titles full of `&amp;`). No
// DOMParser in Workers, so decode numeric refs plus the common named ones.
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = Number(
        body[1] === 'x' || body[1] === 'X' ? `0x${body.slice(2)}` : body.slice(1),
      )
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

const clamp = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

const trim = (value: string | null | undefined, max = MAX_EXCERPT): string | null => {
  if (!value) return null
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim()
  return text ? clamp(text, max) : null
}

export async function fetchMetadata(url: string): Promise<PageMetadata> {
  const hostname = safeHostname(url)
  const found: Record<string, string> = {}
  let documentTitle: string | null = null

  try {
    const res = await fetch(url, {
      headers: {
        // Identifies honestly but still looks like a browser to naive
        // user-agent checks — plenty of publishers 403 unfamiliar agents.
        'user-agent':
          'Mozilla/5.0 (compatible; cailinpitt.com-reading/1.0; +https://cailinpitt.com)',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok || !res.body) return fallback(hostname)

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('html')) return fallback(hostname)

    const rewriter = new HTMLRewriter()
      .on('meta', {
        element(el) {
          const key = el.getAttribute('property') ?? el.getAttribute('name')
          const content = el.getAttribute('content')
          if (!key || !content) return
          const name = key.toLowerCase()
          // First value wins: pages that repeat og:image list the primary first.
          if (!(name in found)) found[name] = content
        },
      })
      .on('title', {
        text(chunk) {
          documentTitle = (documentTitle ?? '') + chunk.text
        },
      })

    await drain(rewriter.transform(res).body!)
  } catch (err) {
    console.error(`fetchMetadata failed for ${url}:`, err)
    return fallback(hostname)
  }

  const pick = (max: number, ...keys: string[]) => {
    for (const key of keys) {
      const value = trim(found[key], max)
      if (value) return value
    }
    return null
  }

  return {
    title: pick(MAX_TITLE, 'og:title', 'twitter:title') ?? trim(documentTitle, MAX_TITLE),
    // A url is not prose: no clamping, and entities still need decoding since
    // `&amp;` is extremely common in query strings.
    image: absolute(pick(2048, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), url),
    excerpt: pick(MAX_EXCERPT, 'og:description', 'twitter:description', 'description'),
    site: pick(MAX_SITE, 'og:site_name', 'twitter:site', 'application-name') ?? hostname,
  }
}

// Handlers only fire as the body is consumed, so the stream has to be read —
// but capped at MAX_BYTES, since a huge page isn't worth reading in full for
// four meta tags.
async function drain(body: ReadableStream): Promise<void> {
  const reader = body.getReader()
  let read = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read += value?.byteLength ?? 0
      if (read > MAX_BYTES) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** og:image is often a site-root-relative path rather than an absolute url. */
function absolute(value: string | null, base: string): string | null {
  if (!value) return null
  try {
    return new URL(value, base).toString()
  } catch {
    return null
  }
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

const fallback = (hostname: string | null): PageMetadata => ({
  title: null,
  image: null,
  excerpt: null,
  site: hostname,
})
