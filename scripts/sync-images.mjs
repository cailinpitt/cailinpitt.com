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

import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageSize } from './image-size.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const IMAGES_DIR = path.join(ROOT, 'public', 'images')
const ORIGINALS_DIR = path.join(ROOT, 'originals')
const BLOG_DIR = path.join(ROOT, 'content', 'blog')
const MANIFEST = path.join(ROOT, 'src', 'lib', 'gallery-images.json')
const GALLERIES_TS = path.join(ROOT, 'src', 'lib', 'galleries.ts')

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif'])
const YEAR = /^\d{4}$/

// Web renditions written from originals/. Galleries get a full size for the lightbox
// plus a grid thumbnail; blog images only ever render at content width, so one size.
const THUMB_WIDTH = 1000
const THUMB_SUFFIX = `-${THUMB_WIDTH}.webp`
const FULL_WIDTH = 2560
const BLOG_WIDTH = 1600
const QUALITY = 82

const args = process.argv.slice(2)
const PRUNE = args.includes('--prune')
const CHECK = args.includes('--check')
const REENCODE = args.includes('--reencode') // redo renditions even if they look current

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

// --- renditions (originals/ -> public/images/) --------------------------------

/** True when `out` exists and is at least as new as `src`. */
async function isCurrent(src, out) {
  if (REENCODE || !existsSync(out)) return false
  const [a, b] = await Promise.all([stat(src), stat(out)])
  return b.mtimeMs >= a.mtimeMs
}

/**
 * Encode every original under originals/<folder>/ into web-sized WebP in
 * public/images/<folder>/. Originals are never uploaded or committed — these
 * renditions are what the site serves.
 */
async function deriveFolder(sharp, folder, isGallery) {
  const from = path.join(ORIGINALS_DIR, folder)
  const to = path.join(IMAGES_DIR, folder)
  const files = await imageFiles(from)
  if (!files.length) return { encoded: 0, bytesIn: 0, bytesOut: 0 }
  await mkdir(to, { recursive: true })

  let encoded = 0
  let bytesIn = 0
  let bytesOut = 0
  for (const name of files) {
    const src = path.join(from, name)
    const base = name.replace(/\.[^.]+$/, '')
    // Galleries: full (lightbox) + thumb (grid). Blog: one content-width rendition.
    const jobs = isGallery
      ? [
          { out: path.join(to, `${base}.webp`), width: FULL_WIDTH },
          { out: path.join(to, `${base}${THUMB_SUFFIX}`), width: THUMB_WIDTH },
        ]
      : [{ out: path.join(to, `${base}.webp`), width: BLOG_WIDTH }]

    for (const { out, width } of jobs) {
      if (await isCurrent(src, out)) continue
      await sharp(src)
        .rotate() // bake in EXIF orientation; the tag is dropped with the metadata
        .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toFile(out)
      encoded++
      bytesOut += (await stat(out)).size
    }
    bytesIn += (await stat(src)).size
  }
  return { encoded, bytesIn, bytesOut }
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

async function deriveAll(galleryKeys) {
  if (!existsSync(ORIGINALS_DIR)) return false
  const folders = (await readdir(ORIGINALS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(collator.compare)
  if (!folders.length) return false

  let sharp
  try {
    ;({ default: sharp } = await import('sharp'))
  } catch {
    console.error('✗ originals/ needs `sharp` to encode web renditions — run `npm install`.')
    process.exit(1)
  }

  let any = false
  for (const folder of folders) {
    // A year folder is a gallery even before it's registered; anything else is a post.
    const isGallery = galleryKeys.has(folder) || YEAR.test(folder)
    const { encoded, bytesIn, bytesOut } = await deriveFolder(sharp, folder, isGallery)
    if (!encoded) continue
    any = true
    console.log(
      `  ${folder}: encoded ${encoded} rendition(s) — ${mb(bytesIn)} of originals → ${mb(bytesOut)} served`,
    )
  }
  return any
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

/** The grid rendition for an image, when one has been generated next to it. */
function thumbFor(src) {
  const thumb = src.replace(/\.[^.]+$/, THUMB_SUFFIX)
  return existsSync(path.join(ROOT, 'public', thumb)) ? thumb : undefined
}

async function syncGallery(key, existing, title) {
  const dir = path.join(IMAGES_DIR, key)
  const all = existsSync(dir) ? await imageFiles(dir) : []
  // Thumbnails ride along on their full-size entry rather than being images of their own.
  const files = all.filter((name) => !name.endsWith(THUMB_SUFFIX))
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
    let entry = image
    if (onDisk) {
      const thumb = thumbFor(image.src)
      if (thumb && thumb !== image.thumb) entry = { ...entry, thumb }
      if (!image.width || !image.height) {
        const size = await imageSize(file)
        if (size) {
          entry = { ...entry, ...size }
          sized++
        }
      }
    }
    out.push(entry)
    seen.add(path.basename(image.src))
  }

  // Then anything new on disk, in natural filename order.
  for (const name of files) {
    const src = `/images/${key}/${name}`
    if (bySrc.has(src) || seen.has(name)) continue
    const size = await imageSize(path.join(dir, name))
    if (!size) console.warn(`  ! could not read dimensions: ${src}`)
    out.push({ src, alt: `Photograph — ${title}`, thumb: thumbFor(src), ...(size ?? {}) })
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
    for (const m of missing) {
      // Most often the post still points at the original filename/extension.
      const web = m.src.replace(/\.[^.]+$/, '.webp')
      const hint = web !== m.src && existsSync(path.join(ROOT, 'public', web)) ? ` → use ${web}` : ''
      console.log(`    ${m.src}  (${m.post})${hint}`)
    }
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
  const registered = new Set(parseDefinitions(galleriesSource).entries.map((e) => e.imageKey))

  // Compress anything new in originals/ into the web renditions the site serves.
  const encoded = CHECK ? false : await deriveAll(registered)
  const folders = await imageFolders()

  // Register year folders that don't have a gallery yet (newest last, so each
  // insertion lands above the previous one).
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
    console.log('  next: npm run images:upload   (push the renditions to R2)')
  } else if (encoded) {
    console.log('\n✓ renditions up to date; manifest unchanged')
  } else {
    console.log('\n✓ already up to date')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
