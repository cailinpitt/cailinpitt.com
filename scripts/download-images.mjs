#!/usr/bin/env node
// Pull images off the live Squarespace CDN into the repo and rewrite the Markdown to
// point at the local copies. Run AFTER scripts/migrate-posts.mjs.
//
// Usage:
//   node scripts/download-images.mjs            # scan markdown + crawl live post URLs
//   node scripts/download-images.mjs --no-crawl # only use URLs already in the markdown
//
// For each blog post it:
//   1. collects Squarespace CDN image URLs from the Markdown body, and (unless --no-crawl)
//      from the live page at https://cailinpitt.com<path>,
//   2. downloads each at high resolution into public/images/<slug>/,
//   3. rewrites the URLs in the Markdown to /images/<slug>/<file>.
//
// Originals aren't on disk, so the live CDN is the source of truth. Re-runnable: already
// downloaded files are skipped.

import { readFile, writeFile, mkdir, readdir, stat, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BLOG_DIR = path.join(ROOT, 'content', 'blog')
const IMAGES_DIR = path.join(ROOT, 'public', 'images')
const SITE = 'https://cailinpitt.com'

const CRAWL = !process.argv.includes('--no-crawl')
const CONCURRENCY = 5

// Matches Squarespace CDN / static asset URLs (with optional query string).
const CDN_RE =
  /https?:\/\/(?:images\.squarespace-cdn\.com|static1\.squarespace\.com|[\w.-]*\.squarespace\.com)\/[^\s"')]+/g

function frontmatterPath(raw, fallback) {
  const m = raw.match(/^path:\s*(.+)$/m)
  return m ? m[1].trim() : fallback
}

function slugFromFile(file) {
  return path.basename(file, '.md')
}

function cleanUrl(url) {
  // Strip a trailing markdown/HTML artifact and any wrapping punctuation.
  return url.replace(/[)>"']+$/, '')
}

// Request a large render of the asset and derive a sane local filename.
function highResUrl(url) {
  const u = new URL(cleanUrl(url))
  if (u.hostname.includes('images.squarespace-cdn.com')) {
    u.searchParams.set('format', '2500w')
  }
  return u.toString()
}

function fileNameFor(url) {
  const u = new URL(cleanUrl(url))
  let name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || 'image')
  name = name.replace(/[^a-zA-Z0-9._-]/g, '-')
  if (!/\.(jpe?g|png|gif|webp|avif|svg)$/i.test(name)) name += '.jpg'
  return name
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 migration' } })
    if (!res.ok) return ''
    return await res.text()
  } catch {
    return ''
  }
}

async function downloadTo(url, dest) {
  if (existsSync(dest)) return 'skip'
  const res = await fetch(highResUrl(url), {
    headers: { 'user-agent': 'Mozilla/5.0 migration' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const type = res.headers.get('content-type') || ''
  if (!type.startsWith('image/')) return 'not-image'
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  return 'ok'
}

async function pool(items, worker) {
  const queue = [...items]
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift()
      await worker(item)
    }
  })
  await Promise.all(runners)
}

async function main() {
  if (!existsSync(BLOG_DIR)) {
    console.error('✗ No content/blog directory. Run `npm run migrate:posts` first.')
    process.exit(1)
  }
  const files = (await readdir(BLOG_DIR)).filter((f) => f.endsWith('.md'))
  let totalDownloaded = 0
  let totalRewritten = 0

  for (const file of files) {
    const filePath = path.join(BLOG_DIR, file)
    const slug = slugFromFile(file)
    let raw = await readFile(filePath, 'utf8')
    const postPath = frontmatterPath(raw, `/blog/${slug}`)

    // 1. Collect candidate URLs.
    const urls = new Set()
    for (const m of raw.matchAll(CDN_RE)) urls.add(cleanUrl(m[0]))

    if (CRAWL) {
      const html = await fetchText(`${SITE}${postPath}`)
      for (const m of html.matchAll(CDN_RE)) {
        const u = cleanUrl(m[0])
        // Only keep content images from the image CDN. The crawl also turns up site
        // assets (site.css, combo.js, favicon) on static1.squarespace.com — skip those.
        if (!/images\.squarespace-cdn\.com/i.test(u)) continue
        if (/favicon|logo|\bicon\b|site\.css|combo\.|\.(css|js|json|woff2?|ttf|map)\b/i.test(u))
          continue
        urls.add(u)
      }
    }

    if (urls.size === 0) continue

    // 2. Download.
    const destDir = path.join(IMAGES_DIR, slug)
    await mkdir(destDir, { recursive: true })
    const map = new Map() // originalUrl -> /images/<slug>/<file>

    await pool([...urls], async (url) => {
      const name = fileNameFor(url)
      const dest = path.join(destDir, name)
      try {
        const result = await downloadTo(url, dest)
        if (result === 'not-image') {
          console.warn(`  ! skipped non-image ${url}`)
          return
        }
        if (result === 'ok') {
          totalDownloaded += 1
          console.log(`  ↓ ${slug}/${name}`)
        }
        // 'ok' or 'skip' (already on disk) → safe to point the Markdown at the local copy.
        map.set(url, `/images/${slug}/${name}`)
      } catch (err) {
        console.warn(`  ! failed ${url} — ${err.message}`)
      }
    })

    // 3. Rewrite the Markdown. Replace any occurrence of each original URL (with or
    //    without query string) with its local path.
    let changed = false
    for (const [orig, local] of map) {
      const base = orig.split('?')[0]
      const re = new RegExp(
        base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\?[^\\s"\')]*)?',
        'g',
      )
      const next = raw.replace(re, local)
      if (next !== raw) {
        raw = next
        changed = true
      }
    }
    if (changed) {
      await writeFile(filePath, raw, 'utf8')
      totalRewritten += 1
    }
  }

  console.log(
    `\nDone. Downloaded ${totalDownloaded} image(s); rewrote ${totalRewritten} post file(s).`,
  )
  await normalizeExtensions()
  await pruneOrphans()
  await reportSize()
}

// Detect the real image type from magic bytes (Squarespace serves WebP at .jpg URLs).
function magicExt(buf) {
  if (buf.length < 12) return null
  const ascii = (s, e) => buf.toString('latin1', s, e)
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (ascii(0, 4) === 'GIF8') return 'gif'
  if (ascii(4, 8) === 'ftyp' && ascii(8, 12).toLowerCase().startsWith('avi')) return 'avif'
  if (ascii(0, 5) === '<?xml' || ascii(0, 4) === '<svg') return 'svg'
  return null
}

const sameExt = (a, b) => a === b || (a === 'jpg' && b === 'jpeg') || (a === 'jpeg' && b === 'jpg')

// Rename files whose extension doesn't match their actual bytes, and update the Markdown.
async function normalizeExtensions() {
  const files = (await readdir(BLOG_DIR)).filter((f) => f.endsWith('.md'))
  let renamed = 0
  for (const file of files) {
    const filePath = path.join(BLOG_DIR, file)
    const slug = slugFromFile(file)
    const dir = path.join(IMAGES_DIR, slug)
    if (!existsSync(dir)) continue
    let raw = await readFile(filePath, 'utf8')
    let changed = false

    for (const name of await readdir(dir)) {
      const abs = path.join(dir, name)
      const buf = await readFile(abs)
      const real = magicExt(buf)
      const ext = name.split('.').pop().toLowerCase()
      if (!real || sameExt(real, ext)) continue

      const baseName = name.replace(/\.[^.]+$/, '')
      let target = `${baseName}.${real}`
      let i = 1
      while (existsSync(path.join(dir, target)) && target !== name) {
        target = `${baseName}-${i++}.${real}`
      }
      await rename(abs, path.join(dir, target))
      raw = raw.split(`/images/${slug}/${name}`).join(`/images/${slug}/${target}`)
      changed = true
      renamed += 1
    }
    if (changed) await writeFile(filePath, raw, 'utf8')
  }
  if (renamed) console.log(`Normalized ${renamed} file extension(s) to match content.`)
}

// Remove downloaded images that no post actually references (crawl over-collects
// page chrome, thumbnails, related-post images, etc.).
async function pruneOrphans() {
  const mdFiles = (await readdir(BLOG_DIR)).filter((f) => f.endsWith('.md'))
  const allMarkdown = (
    await Promise.all(mdFiles.map((f) => readFile(path.join(BLOG_DIR, f), 'utf8')))
  ).join('\n')

  let removed = 0
  for (const slug of existsSync(IMAGES_DIR) ? await readdir(IMAGES_DIR) : []) {
    const dir = path.join(IMAGES_DIR, slug)
    if (!(await stat(dir)).isDirectory()) continue
    const names = await readdir(dir)
    for (const name of names) {
      if (!allMarkdown.includes(`/images/${slug}/${name}`)) {
        await rm(path.join(dir, name))
        removed += 1
      }
    }
    if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true })
  }
  if (removed) console.log(`Pruned ${removed} unreferenced image(s).`)
}

async function reportSize() {
  if (!existsSync(IMAGES_DIR)) return
  let bytes = 0
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(p)
      else bytes += (await stat(p)).size
    }
  }
  await walk(IMAGES_DIR)
  const mb = (bytes / 1024 / 1024).toFixed(1)
  console.log(`public/images is now ${mb} MB.`)
  if (bytes > 1024 * 1024 * 1024) {
    console.log(
      '⚠ Over ~1 GB — consider Git LFS or moving photos to Cloudflare R2 (see plan.md).',
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
