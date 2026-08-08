#!/usr/bin/env node
// Sync everything under images/ into the code that references it.
//
//   npm run images:sync            # update the photo manifest
//   npm run images:sync -- --prune # also drop manifest entries whose file is gone
//   npm run images:sync -- --check # report only, exit 1 if anything is out of date (CI)
//   npm run images:sync -- --reexif # re-read capture metadata from the originals
//   npm run images:sync -- --retint # recompute every tile's placeholder color
//   npm run images:publish         # sync, then upload to R2
//
// What it does:
//   1. Photo folders — images/<year>, a four-digit name and nothing else —
//      are written into src/lib/photos.json as one flat, newest-first feed: real
//      width/height read off disk, a permalink id, a date, an average color for
//      the tile placeholder, and capture metadata (camera, exposure, coarse
//      location) read from the matching original.
//      Existing entries keep their id, hand-written alt text, hand-corrected date,
//      and any metadata already recorded.
//   2. Blog folders (images/<post-slug>) are checked against the markdown:
//      it reports images referenced but missing on disk, and images on disk that
//      nothing references. Nothing to register — blog images are referenced by path.
//
// A four-digit folder name is the whole rule for "this is a photo, not a blog
// image". There is no longer a gallery registry to add anything to: drop files in
// originals/<year>/, run this, and they appear in the feed in date order.
//
// Images themselves are never committed; push them to R2 with `npm run images:upload`.

import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageSize } from './image-size.mjs'
import { readPhotoExif } from './exif.mjs'
import { readTint } from './tint.mjs'
import { assignPhotoId, byNewest, GRID_WIDTHS, renditionPath, resolveDate } from './photo-manifest.mjs'
import { IMAGES_DIR, localImagePath } from './paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ORIGINALS_DIR = path.join(ROOT, 'originals')
const BLOG_DIR = path.join(ROOT, 'content', 'blog')
const MANIFEST = path.join(ROOT, 'src', 'lib', 'photos.json')

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif'])
const YEAR = /^\d{4}$/

// Web renditions written from originals/. Photos get a full size for the permalink
// page plus a grid thumbnail; blog images only ever render at content width, so one size.
const THUMB_WIDTH = 1000
const THUMB_SUFFIX = `-${THUMB_WIDTH}.webp`
/** `-400.webp`, `-800.webp`, … — how a rendition is told apart from an original. */
const GRID_SUFFIXES = GRID_WIDTHS.map((width) => `-${width}.webp`)
const FULL_WIDTH = 2560
const BLOG_WIDTH = 1600
const QUALITY = 82

const args = process.argv.slice(2)
const PRUNE = args.includes('--prune')
const CHECK = args.includes('--check')
const REENCODE = args.includes('--reencode') // redo renditions even if they look current
const REEXIF = args.includes('--reexif') // re-read capture metadata from the originals
const RETINT = args.includes('--retint') // recompute every tile's placeholder color

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

const stemOf = (file) => path.basename(file).replace(/\.[^.]+$/, '')

// sharp is only needed where originals/ is involved (encoding renditions, reading
// EXIF), so it's imported on demand and memoized rather than required up front.
let sharpModule
async function loadSharp() {
  if (sharpModule === undefined) {
    try {
      ;({ default: sharpModule } = await import('sharp'))
    } catch {
      sharpModule = null
    }
  }
  return sharpModule
}

// --- renditions (originals/ -> images/) --------------------------------

/** True when `out` exists and is at least as new as `src`. */
async function isCurrent(src, out) {
  if (REENCODE || !existsSync(out)) return false
  const [a, b] = await Promise.all([stat(src), stat(out)])
  return b.mtimeMs >= a.mtimeMs
}

/**
 * Encode every original under originals/<folder>/ into web-sized WebP in
 * images/<folder>/. Originals are never uploaded or committed — these
 * renditions are what the site serves.
 */
async function deriveFolder(sharp, folder, isPhoto) {
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
    // Photos: full (permalink page) + thumb (feed grid). Blog: one content-width rendition.
    const jobs = isPhoto
      ? [
          { out: path.join(to, `${base}.webp`), width: FULL_WIDTH },
          // One per grid width, so a tile can pick the size it will actually
          // paint at instead of always taking the largest.
          ...GRID_WIDTHS.map((width) => ({
            out: path.join(to, `${base}-${width}.webp`),
            width,
          })),
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

async function deriveAll() {
  if (!existsSync(ORIGINALS_DIR)) return false
  const folders = (await readdir(ORIGINALS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(collator.compare)
  if (!folders.length) return false

  const sharp = await loadSharp()
  if (!sharp) {
    console.error('✗ originals/ needs `sharp` to encode web renditions — run `npm install`.')
    process.exit(1)
  }

  let any = false
  for (const folder of folders) {
    const { encoded, bytesIn, bytesOut } = await deriveFolder(sharp, folder, YEAR.test(folder))
    if (!encoded) continue
    any = true
    console.log(
      `  ${folder}: encoded ${encoded} rendition(s) — ${mb(bytesIn)} of originals → ${mb(bytesOut)} served`,
    )
  }
  return any
}

// --- manifest ----------------------------------------------------------------

/** The grid rendition for an image, when one has been generated next to it. */
function thumbFor(src) {
  const thumb = src.replace(/\.[^.]+$/, THUMB_SUFFIX)
  return existsSync(localImagePath(thumb)) ? thumb : undefined
}

/**
 * Which grid widths actually exist on disk for this photo.
 *
 * Recorded per entry rather than assumed from GRID_WIDTHS: a photo whose
 * original has left the machine keeps whatever renditions were made when it was
 * last synced, and the srcset must not advertise a file that would 404. It is
 * also what photos:rm deletes by.
 */
function widthsFor(src) {
  const found = GRID_WIDTHS.filter((width) => existsSync(localImagePath(renditionPath(src, width))))
  return found.length ? found : undefined
}

/**
 * Map each original's filename stem to its path, so a manifest entry pointing at
 * `/images/2026/IMG_0004.webp` can find `originals/2026/IMG_0004.jpeg` — the
 * rendition has no EXIF of its own, having been encoded without metadata.
 */
async function originalsByStem(year) {
  const dir = path.join(ORIGINALS_DIR, year)
  if (!existsSync(dir)) return new Map()
  const entries = await imageFiles(dir)
  return new Map(entries.map((name) => [stemOf(name), path.join(dir, name)]))
}

/**
 * Rebuild the feed from what's on disk, carrying forward everything an earlier
 * run (or a human) recorded: ids, alt text, dates, capture metadata.
 */
async function syncPhotos(existing) {
  const years = (await imageFolders()).filter((name) => YEAR.test(name))
  const bySrc = new Map(existing.map((photo) => [photo.src, photo]))
  const used = new Set(existing.map((photo) => photo.id).filter(Boolean))
  const out = []
  const stats = new Map()

  for (const year of years) {
    const dir = path.join(IMAGES_DIR, year)
    const originals = await originalsByStem(year)
    // Thumbnails ride along on their full-size entry rather than being photos of their own.
    // Every grid width, not just the thumb: a rendition is an output of this
    // script, and treating one as an original would file it as a photo of its
    // own and then derive renditions of the rendition.
    const files = (await imageFiles(dir)).filter((name) => !GRID_SUFFIXES.some((s) => name.endsWith(s)))
    // Needed for EXIF (which reads originals/) and for the tint (which reads the
    // renditions right here), so it's wanted whenever there is anything to sync —
    // not only in a checkout that happens to have the originals.
    const sharp = files.length ? await loadSharp() : null
    const tally = { total: 0, added: 0, sized: 0, tagged: 0, tinted: 0 }

    for (const name of files) {
      const src = `/images/${year}/${name}`
      const file = path.join(dir, name)
      const prior = bySrc.get(src)
      const thumb = thumbFor(src)
      const widths = widthsFor(src)

      /**
       * Capture metadata is re-read only when the entry has none (or --reexif /
       * --reencode force it): once written it's stable, and the whole point is
       * that it survives even if the original later leaves this machine.
       */
      let exif = prior?.exif
      if (sharp && (!prior?.exif || REENCODE || REEXIF)) {
        const original = originals.get(stemOf(name))
        // May come back undefined, which clears a value an earlier run recorded —
        // the point of --reexif is to be able to fix metadata that was read wrong.
        if (original) exif = (await readPhotoExif(sharp, original)) ?? undefined
      }
      if (exif && !prior?.exif) tally.tagged++

      let size = prior?.width && prior?.height ? { width: prior.width, height: prior.height } : null
      if (!size) {
        size = await imageSize(file)
        if (size) tally.sized++
        else console.warn(`  ! could not read dimensions: ${src}`)
      }

      /**
       * The tile's placeholder color. Read from the grid rendition, which is the
       * image that actually has to load before the tile stops being a blank
       * square. Cached in the manifest like everything else here, so a resync
       * costs nothing once it's been computed.
       */
      let tint = prior?.tint
      if (sharp && (!tint || REENCODE || RETINT)) {
        const from = localImagePath(thumb ?? src)
        tint = await readTint(sharp, from)
        if (tint && !prior?.tint) tally.tinted++
      }

      const resolved = resolveDate({ exif, existing: prior, year })
      const { date, approx } = resolved

      out.push({
        id: prior?.id ?? assignPhotoId(year, stemOf(name), used),
        src,
        thumb,
        ...(widths ? { widths } : {}),
        alt: prior?.alt ?? `Photograph — ${year}`,
        ...(size ?? {}),
        ...(tint ? { tint } : {}),
        year: resolved.year,
        date,
        ...(approx ? { approx: true } : {}),
        ...(exif ? { exif } : {}),
      })
      tally.total++
      if (!prior) tally.added++
    }

    stats.set(year, tally)
  }

  // Entries whose file is no longer on disk. Kept unless --prune, so a folder
  // that happens to be missing locally can't silently empty the feed.
  const onDisk = new Set(out.map((photo) => photo.src))
  const orphans = existing.filter((photo) => !onDisk.has(photo.src))
  if (!PRUNE) out.push(...orphans)

  return { photos: out.sort(byNewest), orphans: orphans.length, stats }
}

// --- blog images -------------------------------------------------------------

async function checkBlogImages(folders) {
  if (!existsSync(BLOG_DIR)) return
  const posts = (await readdir(BLOG_DIR)).filter((f) => f.endsWith('.md'))
  const referenced = new Set()
  const missing = []
  for (const file of posts) {
    const body = await readFile(path.join(BLOG_DIR, file), 'utf8')
    for (const [, src] of body.matchAll(/(?:\]\(|["'(])(\/images\/[^\s)"']+)/g)) {
      referenced.add(src)
      if (!existsSync(localImagePath(src))) missing.push({ post: file, src })
    }
  }

  const unreferenced = []
  for (const folder of folders) {
    if (YEAR.test(folder)) continue
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
      const hint = web !== m.src && existsSync(localImagePath(web)) ? ` → use ${web}` : ''
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
  const before = existsSync(MANIFEST) ? await readFile(MANIFEST, 'utf8') : '[]\n'
  const existing = JSON.parse(before)

  // Compress anything new in originals/ into the web renditions the site serves.
  const encoded = CHECK ? false : await deriveAll()
  const folders = await imageFolders()

  const { photos, orphans, stats } = await syncPhotos(existing)
  for (const [year, tally] of stats) {
    const notes = [
      tally.added && `+${tally.added} new`,
      tally.sized && `${tally.sized} sized`,
      tally.tagged && `${tally.tagged} exif`,
      tally.tinted && `${tally.tinted} tinted`,
    ].filter(Boolean)
    console.log(`  ${year}: ${tally.total} photo(s)${notes.length ? ` (${notes.join(', ')})` : ''}`)
  }
  if (orphans) {
    console.log(
      PRUNE
        ? `  -${orphans} pruned (no longer on disk)`
        : `  ! ${orphans} manifest entr(ies) not on disk (kept — pass --prune to drop)`,
    )
  }

  const manifestJson = JSON.stringify(photos, null, 2) + '\n'
  const manifestChanged = manifestJson !== before

  const blogMissing = await checkBlogImages(folders)

  if (CHECK) {
    console.log(manifestChanged ? '\n✗ out of date — run `npm run images:sync`' : '\n✓ up to date')
    process.exit(manifestChanged || blogMissing ? 1 : 0)
  }

  if (manifestChanged) {
    await writeFile(MANIFEST, manifestJson)
    console.log(`\n✓ updated src/lib/photos.json (${photos.length} photos)`)
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
