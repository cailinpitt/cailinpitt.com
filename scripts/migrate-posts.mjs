#!/usr/bin/env node
// Convert a Squarespace "Export → WordPress" (WXR) XML file into Markdown files,
// one per blog post, preserving the exact original URL path.
//
// Usage:
//   node scripts/migrate-posts.mjs [path/to/squarespace-export.xml]
//
// Output: content/blog/<slug>.md with frontmatter:
//   title, date (YYYY-MM-DD), path (exact preserved URL), slug, tags, description
//
// Notes:
// - Image URLs are left as-is in the Markdown; run scripts/download-images.mjs afterward
//   to pull them local and rewrite the links.
// - HTML→Markdown is ~90% accurate. Review each file by hand, especially embeds.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStringPromise } from 'xml2js'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'content', 'blog')

const inputArg = process.argv[2] ?? 'squarespace-export.xml'
const inputPath = path.resolve(ROOT, inputArg)

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
})
turndown.use(gfm)
// Preserve embeds and figures as raw HTML so they survive (rehype-raw renders them).
turndown.keep(['iframe', 'figure', 'figcaption', 'sub', 'sup'])

// Squarespace's WordPress export wraps images in WordPress [caption] shortcodes and
// occasionally [embed] shortcodes — literal bracket text, not HTML. Convert them to clean
// elements before turndown runs, otherwise they leak through as escaped \[caption ...\].
function preprocessHtml(html) {
  return String(html)
    .replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/gi, (_m, inner) => {
      const img = (inner.match(/<img[^>]*>/i) || [''])[0]
      const caption = inner.replace(/<img[^>]*>/i, '').trim()
      return `<figure>${img}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`
    })
    .replace(/\[\/?embed[^\]]*\]/gi, '')
}

function asArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function toIsoDate(item) {
  const raw =
    item['wp:post_date_gmt'] || item['wp:post_date'] || item.pubDate || ''
  const d = new Date(typeof raw === 'string' ? raw.replace(' ', 'T') : raw)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

function pathFromLink(link, slug, isoDate) {
  if (link) {
    try {
      return new URL(link).pathname.replace(/\/$/, '')
    } catch {
      if (link.startsWith('/')) return link.replace(/\/$/, '')
    }
  }
  // Fallback: reconstruct the Squarespace dated path (non-zero-padded month/day).
  if (isoDate) {
    const [y, m, d] = isoDate.split('-').map((n) => parseInt(n, 10))
    return `/blog/${y}/${m}/${d}/${slug}`
  }
  return `/blog/${slug}`
}

function tagsFromCategories(item) {
  return asArray(item.category)
    .map((c) => (typeof c === 'string' ? c : c?._ ?? ''))
    .filter(Boolean)
}

function descriptionFrom(item, markdown) {
  // Derive from the body's first real prose: drop figures/HTML, images, links, and
  // leftover markdown punctuation so the meta description is clean readable text.
  const clean = markdown
    .replace(/<[^>]+>/g, ' ') // raw HTML (figures, iframes)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // markdown images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → link text
    .replace(/https?:\/\/\S+/g, ' ') // bare URLs
    .replace(/[#>*_`~|]/g, ' ') // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim()

  const excerpt = item['excerpt:encoded']
  const source =
    (typeof excerpt === 'string' && excerpt.trim() && !/[<\[]|https?:\/\//.test(excerpt)
      ? excerpt.trim()
      : '') || clean
  if (!source) return ''
  return source.length > 155 ? `${source.slice(0, 152).trimEnd()}…` : source
}

function frontmatter(fields) {
  const lines = ['---']
  lines.push(`title: ${JSON.stringify(fields.title)}`)
  lines.push(`date: ${fields.date}`)
  lines.push(`path: ${fields.path}`)
  lines.push(`slug: ${fields.slug}`)
  lines.push(`tags: ${JSON.stringify(fields.tags)}`)
  if (fields.description)
    lines.push(`description: ${JSON.stringify(fields.description)}`)
  lines.push('---', '')
  return lines.join('\n')
}

async function main() {
  if (!existsSync(inputPath)) {
    console.error(`✗ Export file not found: ${inputPath}`)
    console.error(
      '  Export from Squarespace: Settings → Import / Export → Export → WordPress,\n' +
        '  save the .xml at the repo root (or pass its path as an argument).',
    )
    process.exit(1)
  }

  const xml = await readFile(inputPath, 'utf8')
  const parsed = await parseStringPromise(xml, { explicitArray: false })
  const items = asArray(parsed?.rss?.channel?.item)

  await mkdir(OUT_DIR, { recursive: true })

  let written = 0
  const seenPaths = new Set()
  const fileNames = new Set()

  for (const item of items) {
    const type = item['wp:post_type']
    const status = item['wp:status']
    if (type !== 'post') continue
    if (status && status !== 'publish') continue

    const isoDate = toIsoDate(item)

    // wp:post_name on Squarespace can be the full dated path (e.g. "2015/10/1/title"),
    // so use it only to help build the URL, never as a literal filename.
    const postName = item['wp:post_name'] ? String(item['wp:post_name']) : ''
    const titleSlug = String(item.title || 'untitled')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    const urlPath = pathFromLink(item.link, postName || titleSlug, isoDate)

    if (seenPaths.has(urlPath)) {
      console.warn(`! Duplicate path, skipping: ${urlPath}`)
      continue
    }
    seenPaths.add(urlPath)

    // The post slug is the last URL segment; flatten it for the filename.
    const slug = urlPath.split('/').filter(Boolean).pop() || titleSlug
    let fileSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (fileNames.has(fileSlug)) fileSlug = `${fileSlug}-${isoDate || written}`
    fileNames.add(fileSlug)

    const html = preprocessHtml(item['content:encoded'] || '')
    const markdown = turndown.turndown(html).trim()

    const fields = {
      title: String(item.title || slug),
      date: isoDate,
      path: urlPath,
      slug,
      tags: tagsFromCategories(item),
      description: descriptionFrom(item, markdown),
    }

    const fileName = `${fileSlug}.md`
    await writeFile(
      path.join(OUT_DIR, fileName),
      frontmatter(fields) + markdown + '\n',
      'utf8',
    )
    written += 1
    console.log(`✓ ${fileName.padEnd(48)} → ${urlPath}`)
  }

  console.log(`\nDone. Wrote ${written} post(s) to content/blog/.`)
  console.log('Next: review the Markdown, then run `npm run migrate:images`.')
  if (written > 0) console.log('Remember to delete content/blog/example.md.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
