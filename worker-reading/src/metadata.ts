// Social-card metadata (title, image, description, site) from a page's HTML via
// HTMLRewriter. Best-effort: a blocked or tag-less page must still be loggable.
//   title   — og/twitter, else JSON-LD headline, else <title>
//   excerpt — longest of og/twitter/meta description and JSON-LD, else first <p>
// Blocked/flaky fetches retry once as a link-unfurler UA (many publishers
// allowlist those); enrich.ts retries the rest off the cron.

const TIMEOUT_MS = 6_000
const MAX_BYTES = 1024 * 1024
const MAX_LD_BYTES = 128 * 1024

export interface PageMetadata {
  title: string | null
  image: string | null
  excerpt: string | null
  site: string | null
}

const MAX_TITLE = 200
const MAX_EXCERPT = 400
const MAX_SITE = 60

/** Min length for a <p> to be used as an excerpt fallback. */
const MIN_PARAGRAPH = 100

/** Boilerplate a first <p> often is when the real content is behind a wall. */
const BOILERPLATE_RE =
  /data.?min(e|ing)|automated means|subscribe to (read|continue)|sign in to|enable javascript|accept (all )?cookies|all rights reserved|©\s*\d{4}/i

const HONEST_UA = 'Mozilla/5.0 (compatible; cailinpitt.com-reading/1.0; +https://cailinpitt.com)'
const UNFURL_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'

/** Tried in order; the unfurler UA only on a block or failure. */
const ATTEMPTS = [HONEST_UA, UNFURL_UA]

/** Interstitial <title>s — treat a match as a failed fetch, not a real title. */
const CHALLENGE_RE =
  /^(just a moment|attention required|are you a robot|verify(ing)? you are (a )?human|.*security checkpoint|access denied|bot verification|please wait|checking your browser|one more step|pardon our interruption)/i

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

interface Scrape {
  found: Record<string, string>
  documentTitle: string | null
  ld: string[]
  paragraphs: string[]
}

type Attempt = { status: 'ok'; data: Scrape } | { status: 'retry' } | { status: 'dead' }

async function scrape(url: string, ua: string): Promise<Attempt> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    console.error(`fetchMetadata: request failed for ${url}:`, err)
    return { status: 'retry' }
  }

  // Blocks and 5xx may clear on a retry; 401/404/410 and non-HTML won't.
  if ([403, 406, 429, 451].includes(res.status) || res.status >= 500) return { status: 'retry' }
  if (!res.ok || !res.body) return { status: 'dead' }
  if (!(res.headers.get('content-type') ?? '').includes('html')) return { status: 'dead' }

  const found: Record<string, string> = {}
  let documentTitle: string | null = null

  const ld: string[] = []
  let ldBuf: string | null = null
  const flushLd = () => {
    if (ldBuf && ldBuf.trim()) ld.push(ldBuf)
    ldBuf = null
  }

  const paragraphs: string[] = []
  let pBuf: string | null = null
  const flushParagraph = () => {
    const text = pBuf?.replace(/\s+/g, ' ').trim() ?? ''
    if (text.length >= MIN_PARAGRAPH && paragraphs.length < 12 && !BOILERPLATE_RE.test(text)) {
      paragraphs.push(text)
    }
    pBuf = null
  }

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
    // `head title` only: a page with inline SVG charts can carry hundreds of
    // <title> tooltip elements, and a bare selector concatenates them all.
    .on('head title', {
      text(chunk) {
        documentTitle = (documentTitle ?? '') + chunk.text
      },
    })
    .on('script', {
      // Flush the previous block first: concatenated JSON docs don't parse.
      element(el) {
        flushLd()
        const type = (el.getAttribute('type') ?? '').trim().toLowerCase()
        ldBuf = type.startsWith('application/ld+json') ? '' : null
      },
      text(chunk) {
        if (ldBuf !== null && ldBuf.length < MAX_LD_BYTES) ldBuf += chunk.text
      },
    })
    .on('p', {
      // Flush on next open, not onEndTag (unreliable for an implied </p>).
      element() {
        flushParagraph()
        pBuf = ''
      },
      text(chunk) {
        if (pBuf !== null && pBuf.length < 2_000) pBuf += chunk.text
      },
    })

  try {
    await drain(rewriter.transform(res).body!)
  } catch (err) {
    console.error(`fetchMetadata: parse failed for ${url}:`, err)
    return { status: 'retry' }
  }
  flushLd()
  flushParagraph()

  return { status: 'ok', data: { found, documentTitle, ld, paragraphs } }
}

export async function fetchMetadata(url: string): Promise<PageMetadata> {
  const hostname = safeHostname(url)

  for (let i = 0; i < ATTEMPTS.length; i++) {
    const attempt = await scrape(url, ATTEMPTS[i])
    if (attempt.status === 'dead') break
    if (attempt.status === 'retry') continue

    const meta = assemble(attempt.data, url, hostname)
    // Challenge page served 200: let the next UA try rather than store its title.
    if (meta.title && CHALLENGE_RE.test(meta.title)) {
      if (i < ATTEMPTS.length - 1) continue
      return fallback(hostname)
    }
    return meta
  }

  return fallback(hostname)
}

function assemble(s: Scrape, url: string, hostname: string | null): PageMetadata {
  const pick = (max: number, ...keys: string[]) => {
    for (const key of keys) {
      const value = trim(s.found[key], max)
      if (value) return value
    }
    return null
  }
  // Longest wins for the description: an unescaped `"` in a `content=` attribute
  // makes HTMLRewriter return the value truncated at that quote, and a sibling
  // tag (or JSON-LD) usually has the same text escaped and intact.
  const longest = (max: number, ...values: (string | null | undefined)[]) => {
    let best: string | null = null
    for (const value of values) {
      const v = trim(value, max)
      if (v && (!best || v.length > best.length)) best = v
    }
    return best
  }
  const jsonLd = parseJsonLd(s.ld)

  return {
    title:
      pick(MAX_TITLE, 'og:title', 'twitter:title') ??
      trim(jsonLd.title, MAX_TITLE) ??
      trim(s.documentTitle, MAX_TITLE),
    excerpt:
      longest(
        MAX_EXCERPT,
        s.found['og:description'],
        s.found['twitter:description'],
        s.found['description'],
        jsonLd.description,
      ) ?? trim(s.paragraphs[0], MAX_EXCERPT),
    image: absolute(
      pick(2048, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src') ??
        jsonLd.image ??
        null,
      url,
    ),
    site: pick(MAX_SITE, 'og:site_name', 'twitter:site', 'application-name') ?? hostname,
  }
}

interface JsonLd {
  title?: string
  description?: string
  image?: string
}

/** Fallback for pages with no og tags but a JSON-LD block. */
function parseJsonLd(blocks: string[]): JsonLd {
  const out: JsonLd = {}
  for (const raw of blocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    for (const node of ldNodes(parsed)) {
      const type = ldType(node['@type'])
      // name/description are only meaningful on a content node; headline always.
      const content = /article|posting|webpage|report|review/i.test(type)

      if (!out.title) {
        const t = ldString(node.headline) ?? (content ? ldString(node.name) : null)
        if (t) out.title = t
      }
      if (!out.description && content) {
        const d = ldString(node.description)
        if (d) out.description = d
      }
      if (!out.image) {
        const img = ldImage(node.image ?? node.thumbnailUrl)
        if (img) out.image = img
      }
    }
  }
  return out
}

type LdNode = Record<string, unknown>

function* ldNodes(data: unknown): Generator<LdNode> {
  if (Array.isArray(data)) {
    for (const item of data) yield* ldNodes(item)
    return
  }
  if (!data || typeof data !== 'object') return
  const obj = data as LdNode
  if (Array.isArray(obj['@graph'])) {
    for (const item of obj['@graph']) yield* ldNodes(item)
    return
  }
  yield obj
}

const ldType = (value: unknown): string =>
  Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : ''

const ldString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

function ldImage(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value)) return ldImage(value[0])
  if (value && typeof value === 'object') return ldString((value as LdNode).url)
  return null
}

// Handlers fire only as the body is read; cap the read at MAX_BYTES.
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
