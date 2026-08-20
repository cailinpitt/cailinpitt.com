// Scrapes a link's own OG metadata for the Twitter/Bluesky-style card a note's
// attached link gets. Runs entirely inside the Worker — no sharp/satori needed,
// unlike scripts/generate-note-og.mjs, since there's nothing to render, just a
// card close to the source page's own title/description/image. Two callers in
// index.ts: the live preview route (scrape only), and the background job that
// persists a card after publish (scrape + re-host the image).

export interface LinkPreview {
  title: string | null
  description: string | null
  /** Absolute URL, resolved against the page it came from. Not re-hosted here. */
  image: string | null
}

/** Enough to cover a page's <head> without downloading the whole document. */
const HEAD_BYTES = 200_000

const UA = 'cailinpitt.com-link-card/1.0 (+https://cailinpitt.com)'

async function fetchCapped(url: string, maxBytes: number): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'user-agent': UA, accept: 'text/html,*/*' },
  })
  if (!res.ok || !res.body) throw new Error(`fetch ${url}: ${res.status}`)

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total >= maxBytes) {
      reader.cancel().catch(() => {})
      break
    }
  }
  return new TextDecoder().decode(concat(chunks))
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Just enough entity decoding for what turns up in title/description meta content. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
}

/** A small regex scanner, not a general HTML parser — the same tradeoff NoteText.tsx makes against Markdown. */
function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of html.matchAll(/<meta\s+([^>]*)>/gi)) {
    const attrs = m[1]
    const prop = attrs.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]
    const content = attrs.match(/content=["']([^"']*)["']/i)?.[1]
    if (prop && content !== undefined) out[prop.toLowerCase()] = decodeEntities(content)
  }
  return out
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return m ? decodeEntities(m[1]).trim() : null
}

const clamp = (s: string, n: number): string | null => {
  if (!s) return null
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '') + '…'
}

/** Best-effort: any failure (dead link, timeout, blocked fetch) throws, and every caller treats that as "no card." */
export async function scrapeLink(url: string): Promise<LinkPreview> {
  const html = await fetchCapped(url, HEAD_BYTES)
  const meta = metaTags(html)

  const title = clamp(meta['og:title'] || meta['twitter:title'] || titleTag(html) || '', 120)
  const description = clamp(
    meta['og:description'] || meta['twitter:description'] || meta['description'] || '',
    200,
  )
  const imageRaw = meta['og:image'] || meta['twitter:image'] || null
  const image = imageRaw ? new URL(imageRaw, url).href : null

  return { title, description, image }
}
