#!/usr/bin/env node
// Sync everything under public/images/ into the code that references it.
//
//   npm run images:sync            # update the gallery manifest + register new galleries
//   npm run images:sync -- --prune # also drop manifest entries whose file is gone
//   npm run images:sync -- --check # report only, exit 1 if anything is out of date (CI)
//   npm run images:publish         # sync, then upload to R2
//
// What it does:
//   1. Gallery folders (public/images/<year>, plus any imageKey already registered in
//      src/lib/galleries.ts) are written into src/lib/gallery-images.json with real
//      width/height read off disk. Existing entries keep their order and hand-written
//      alt text; new files are appended in natural filename order.
//   2. A year folder with no gallery registered yet is added to `galleryDefinitions`
//      in src/lib/galleries.ts, newest-first. Non-year galleries stay hand-written.
//   3. Blog folders (public/images/<post-slug>) are checked against the markdown:
//      it reports images referenced but missing on disk, and images on disk that
//      nothing references. Nothing to register — blog images are referenced by path.
//
// Images themselves are never committed; push them to R2 with `npm run images:upload`.

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageSize } from './image-size.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const IMAGES_DIR = path.join(ROOT, 'public', 'images')
const BLOG_DIR = path.join(ROOT, 'content', 'blog')
const MANIFEST = path.join(ROOT, 'src', 'lib', 'gallery-images.json')
const GALLERIES_TS = path.join(ROOT, 'src', 'lib', 'galleries.ts')

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif'])
const YEAR = /^\d{4}$/

const args = process.argv.slice(2)
const PRUNE = args.includes('--prune')
const CHECK = args.includes('--check')

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

async function imageFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort(collator.compare)
}

async function imageFolders() {
  if (!existsSync(IMAGES_DIR)) return []
  const entries = await readdir(IMAGES_DIR, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(collator.compare)
}

// --- galleries.ts ------------------------------------------------------------

/** Parsed one-per-line `{ path: '/x', title: 'X', imageKey: 'x', … }` entries. */
function parseDefinitions(source) {
  const start = source.indexOf('export const galleryDefinitions')
  const open = source.indexOf('[', start)
  const close = source.indexOf('\n]', open)
  if (start < 0 || open < 0 || close < 0) {
    throw new Error('Could not find galleryDefinitions in src/lib/galleries.ts')
  }
  const body = source.slice(open + 1, close)
  const entries = []
  for (const [index, line] of body.split('\n').entries()) {
    const key = line.match(/imageKey:\s*'([^']+)'/)
    const title = line.match(/title:\s*'([^']+)'/)
    if (key) entries.push({ line: index, imageKey: key[1], title: title?.[1] ?? '' })
  }
  return { open, close, body, entries }
}

/** Insert a new year gallery into the newest-first list. */
function withGallery(source, year) {
  const { open, close, body, entries } = parseDefinitions(source)
  const lines = body.split('\n')
  const entry = `  { path: '/${year}', title: '${year}', imageKey: '${year}' },`
  // Newest-first: sit above the first gallery whose title year is older than this one.
  const older = entries.find((e) => YEAR.test(e.title) && Number(e.title) < Number(year))
  const at = older ? older.line : lines.length - 1
  lines.splice(at, 0, entry)
  return source.slice(0, open + 1) + lines.join('\n') + source.slice(close)
}

// --- manifest ----------------------------------------------------------------

async function syncGallery(key, existing, title) {
  const dir = path.join(IMAGES_DIR, key)
  const files = existsSync(dir) ? await imageFiles(dir) : []
  const bySrc = new Map(existing.map((image) => [image.src, image]))
  const seen = new Set()
  const out = []
  const added = []
  let sized = 0

  // Existing entries first, in their current (possibly hand-tuned) order.
  for (const image of existing) {
    const file = path.join(ROOT, 'public', image.src)
    const onDisk = existsSync(file)
    if (!onDisk && PRUNE) continue
    if (onDisk && (!image.width || !image.height)) {
      const size = await imageSize(file)
      if (size) {
        out.push({ ...image, ...size })
        sized++
        seen.add(path.basename(image.src))
        continue
      }
    }
    out.push(image)
    seen.add(path.basename(image.src))
  }

  // Then anything new on disk, in natural filename order.
  for (const name of files) {
    const src = `/images/${key}/${name}`
    if (bySrc.has(src) || seen.has(name)) continue
    const size = await imageSize(path.join(dir, name))
    if (!size) console.warn(`  ! could not read dimensions: ${src}`)
    out.push({ src, alt: `Photograph — ${title}`, ...(size ?? {}) })
    added.push(src)
  }

  const missing = out.filter((image) => !existsSync(path.join(ROOT, 'public', image.src))).length
  const pruned = PRUNE ? existing.length - (out.length - added.length) : 0
  return { images: out, added, pruned, missing, sized }
}

// --- blog images -------------------------------------------------------------

async function checkBlogImages(folders, galleryKeys) {
  if (!existsSync(BLOG_DIR)) return
  const posts = (await readdir(BLOG_DIR)).filter((f) => f.endsWith('.md'))
  const referenced = new Set()
  const missing = []
  for (const file of posts) {
    const body = await readFile(path.join(BLOG_DIR, file), 'utf8')
    for (const [, src] of body.matchAll(/(?:\]\(|["'(])(\/images\/[^\s)"']+)/g)) {
      referenced.add(src)
      if (!existsSync(path.join(ROOT, 'public', src))) missing.push({ post: file, src })
    }
  }

  const unreferenced = []
  for (const folder of folders) {
    if (galleryKeys.has(folder)) continue
    for (const name of await imageFiles(path.join(IMAGES_DIR, folder))) {
      const src = `/images/${folder}/${name}`
      if (!referenced.has(src)) unreferenced.push(src)
    }
  }

  if (missing.length) {
    console.log(`\n✗ ${missing.length} blog image(s) referenced but not on disk:`)
    for (const m of missing) console.log(`    ${m.src}  (${m.post})`)
  }
  if (unreferenced.length) {
    console.log(`\n· ${unreferenced.length} blog image(s) on disk that no post references:`)
    for (const src of unreferenced.slice(0, 20)) console.log(`    ${src}`)
    if (unreferenced.length > 20) console.log(`    …and ${unreferenced.length - 20} more`)
  }
  return missing.length > 0
}

// --- main --------------------------------------------------------------------

async function main() {
  let galleriesSource = await readFile(GALLERIES_TS, 'utf8')
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const folders = await imageFolders()

  // Register year folders that don't have a gallery yet (newest last, so each
  // insertion lands above the previous one).
  const registered = new Set(parseDefinitions(galleriesSource).entries.map((e) => e.imageKey))
  const newYears = folders.filter((f) => YEAR.test(f) && !registered.has(f)).sort(collator.compare)
  for (const year of newYears) {
    galleriesSource = withGallery(galleriesSource, year)
    registered.add(year)
    console.log(`+ registered gallery /${year}`)
  }

  const definitions = parseDefinitions(galleriesSource).entries
  const galleryKeys = new Set(definitions.map((d) => d.imageKey))
  const next = {}

  for (const { imageKey, title } of definitions) {
    if (next[imageKey]) continue // aliases (e.g. /past-work → 2022) share a key
    const existing = manifest[imageKey] ?? []
    const { images, added, pruned, missing, sized } = await syncGallery(imageKey, existing, title || imageKey)
    next[imageKey] = images
    const notes = [
      added.length && `+${added.length} new`,
      pruned && `-${pruned} pruned`,
      sized && `${sized} sized`,
      missing && `${missing} not on disk`,
    ].filter(Boolean)
    console.log(`  ${imageKey}: ${images.length} image(s)${notes.length ? ` (${notes.join(', ')})` : ''}`)
  }

  // Keep manifest keys that no gallery references rather than silently dropping them.
  for (const [key, images] of Object.entries(manifest)) {
    if (!(key in next)) {
      next[key] = images
      console.warn(`  ! ${key}: in the manifest but no gallery uses it (kept)`)
    }
  }

  // Preserve the manifest's existing key order (new galleries append) to keep diffs small.
  const order = [...Object.keys(manifest), ...Object.keys(next).filter((k) => !(k in manifest))]
  const ordered = Object.fromEntries(order.map((key) => [key, next[key]]))
  const manifestJson = JSON.stringify(ordered, null, 2) + '\n'
  const manifestChanged = manifestJson !== (await readFile(MANIFEST, 'utf8'))

  const blogMissing = await checkBlogImages(folders, galleryKeys)

  if (CHECK) {
    const stale = manifestChanged || newYears.length > 0
    console.log(stale ? '\n✗ out of date — run `npm run images:sync`' : '\n✓ up to date')
    process.exit(stale || blogMissing ? 1 : 0)
  }

  if (manifestChanged) await writeFile(MANIFEST, manifestJson)
  if (newYears.length) await writeFile(GALLERIES_TS, galleriesSource)

  if (manifestChanged || newYears.length) {
    console.log('\n✓ updated src/lib/gallery-images.json' + (newYears.length ? ' + src/lib/galleries.ts' : ''))
    console.log('  next: npm run images:upload   (push the photos to R2)')
  } else {
    console.log('\n✓ already up to date')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
