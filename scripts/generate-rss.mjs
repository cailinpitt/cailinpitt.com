#!/usr/bin/env node
// Generate dist/feed.xml — a full-content RSS 2.0 feed of the blog. Runs after
// `npm run build` (part of the "postbuild" script).
//
// Metadata (title, date, tags, summary) comes from content/blog/*.md, but the item
// bodies are lifted out of the *prerendered* HTML in dist/ rather than re-rendered
// from markdown here. That's the whole trick: the site already turns markdown into
// HTML once, with GFM, raw HTML embeds, and the R2 image rewriting — reimplementing
// any of that in this script would be a second renderer to keep in sync, and the
// feed would quietly drift from the page.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BLOG = path.join(ROOT, 'content', 'blog')
const DIST = path.join(ROOT, 'dist')
const SITE = 'https://cailinpitt.com'
const FEED_PATH = '/feed.xml'
const TITLE = 'Cailin Pitt'
const DESCRIPTION = 'Writing by Cailin Pitt.'
const AUTHOR = 'Cailin Pitt'

/**
 * How many posts carry their full text in the feed.
 *
 * The archive is ~35 posts and the whole thing would still only be a couple
 * hundred kilobytes, but a feed is re-fetched on a timer forever, and readers
 * only ever show a new subscriber the most recent items anyway. Older posts stay
 * a click away at /blog.
 */
const MAX_ITEMS = 20

// Mirrors src/lib/frontmatter.ts (same hand-rolled format the migration emits).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseValue(value) {
  if (value.startsWith('[')) {
    try {
      const arr = JSON.parse(value)
      if (Array.isArray(arr)) return arr.map(String)
    } catch {
      /* fall through */
    }
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseFrontmatter(raw) {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { data: {}, body: raw.trim() }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    data[line.slice(0, sep).trim()] = parseValue(line.slice(sep + 1).trim())
  }
  return { data, body: raw.slice(m[0].length).trim() }
}

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * CDATA can't contain the sequence that ends it, so a body that does gets split
 * across two sections. Rare, but a post about XML would otherwise break the feed.
 */
const cdata = (value) => `<![CDATA[${String(value).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`

/** RFC 822 date, which RSS requires — not the ISO string the frontmatter carries. */
function rfc822(iso) {
  const d = new Date(iso.includes('T') ? iso : `${iso}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d.toUTCString()
}

/**
 * The rendered post body, pulled out of its prerendered page.
 *
 * `<div class="post-body">` is what BlogPost.tsx wraps the markdown in, and the
 * markup is minified onto one line with `</div></article>` closing it, so the
 * first of those after the opening tag is the end of the body — no HTML parser
 * needed. Nested divs inside a post (raw embeds) are safe because they close
 * before the article does.
 */
function extractBody(html) {
  const open = html.indexOf('<div class="post-body">')
  if (open === -1) return null
  const start = open + '<div class="post-body">'.length
  const end = html.indexOf('</div></article>', start)
  if (end === -1) return null
  return html.slice(start, end)
}

/**
 * Root-relative URLs become absolute: a feed item is read somewhere that isn't
 * this site, where `/blog/…` points at the reader's own host. Images are already
 * absolute R2 URLs by the time they're rendered, so this is mostly links.
 */
const absolutize = (html) =>
  html.replace(/\b(href|src|srcset|poster)="\/(?!\/)/g, `$1="${SITE}/`)

async function main() {
  if (!existsSync(DIST)) {
    console.error('✗ No dist/ — run `npm run build` first.')
    process.exit(1)
  }

  const files = (await readdir(BLOG)).filter((file) => file.endsWith('.md'))
  const posts = []
  for (const file of files) {
    const { data } = parseFrontmatter(await readFile(path.join(BLOG, file), 'utf8'))
    const slug = file.replace(/\.md$/, '')
    posts.push({
      path: data.path ?? `/blog/${slug}`,
      title: data.title ?? slug,
      date: data.date ?? '',
      description: data.description ?? '',
      tags: Array.isArray(data.tags) ? data.tags : [],
    })
  }
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const items = []
  for (const post of posts.slice(0, MAX_ITEMS)) {
    const url = SITE + post.path
    const file = path.join(DIST, `${post.path.replace(/^\//, '')}.html`)
    let content = null
    if (existsSync(file)) {
      const body = extractBody(await readFile(file, 'utf8'))
      if (body) content = absolutize(body)
      else console.warn(`  ! no post-body found in ${path.relative(ROOT, file)}`)
    } else {
      console.warn(`  ! no prerendered page for ${post.path}`)
    }

    const pubDate = rfc822(post.date)
    // Falls back to the summary so an item is never empty, even if the page it
    // came from went missing.
    const parts = [
      `    <title>${escapeXml(post.title)}</title>`,
      `    <link>${escapeXml(url)}</link>`,
      `    <guid isPermaLink="true">${escapeXml(url)}</guid>`,
    ]
    if (pubDate) parts.push(`    <pubDate>${pubDate}</pubDate>`)
    parts.push(`    <dc:creator>${cdata(AUTHOR)}</dc:creator>`)
    if (post.description) parts.push(`    <description>${cdata(post.description)}</description>`)
    for (const tag of post.tags) parts.push(`    <category>${cdata(tag)}</category>`)
    if (content) parts.push(`    <content:encoded>${cdata(content)}</content:encoded>`)
    items.push(`  <item>\n${parts.join('\n')}\n  </item>`)
  }

  // lastBuildDate is the newest post rather than "now": every deploy rewrites this
  // file, and a timestamp that moves when nothing was published tells subscribers
  // there is something new when there isn't.
  const newest = posts.find((post) => rfc822(post.date))
  const lastBuild = newest ? rfc822(newest.date) : null

  const channel = [
    `  <title>${escapeXml(TITLE)}</title>`,
    `  <link>${SITE}/blog</link>`,
    `  <description>${escapeXml(DESCRIPTION)}</description>`,
    `  <language>en-us</language>`,
    `  <atom:link href="${SITE}${FEED_PATH}" rel="self" type="application/rss+xml" />`,
  ]
  if (lastBuild) channel.push(`  <lastBuildDate>${lastBuild}</lastBuildDate>`)

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" ` +
    `xmlns:content="http://purl.org/rss/1.0/modules/content/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `<channel>\n${channel.join('\n')}\n${items.join('\n')}\n</channel>\n</rss>\n`

  await writeFile(path.join(DIST, FEED_PATH.replace(/^\//, '')), xml, 'utf8')
  console.log(`✓ feed.xml with ${items.length} of ${posts.length} posts`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
