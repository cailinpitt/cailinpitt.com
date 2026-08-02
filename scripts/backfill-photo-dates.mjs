#!/usr/bin/env node
// Recover a date for the photos that came back from Squarespace EXIF-stripped.
//
//   node scripts/backfill-photo-dates.mjs [--dry-run]
//
// Everything shot before 2026 lost its metadata somewhere in the Squarespace
// round trip, so `npm run images:sync` can only date those photos to the first of
// their year. The site export (squarespace-export.xml) still holds the CDN URL of
// each file, and a Squarespace CDN URL carries the upload time in it:
//
//   .../content/v1/<site>/1684719568141-XZ7EMJQPNBQ1L59K446J/IMG_2300.jpg
//                         ^ milliseconds
//
// That is when the file was *uploaded*, not when it was taken — but the two
// track each other closely enough to order a feed by, and it's the only signal
// left. So it's written as an approximate date, which the UI renders as a bare
// year rather than a day (see formatPhotoDate in src/lib/photos.ts).
//
// Idempotent, and safe to run after hand-correcting a date: it only replaces the
// placeholder that sync writes (January 1st of the folder's year, flagged
// approximate). A real capture time, or any date a human has touched, is left
// exactly as it is.

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { approxDateForYear, byNewest } from './photo-manifest.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MANIFEST = path.join(ROOT, 'src', 'lib', 'photos.json')
const EXPORT = path.join(ROOT, 'squarespace-export.xml')

const DRY_RUN = process.argv.includes('--dry-run')

/**
 * Every `<13-digit ms>-<KEY>/<filename>` in the export, as stem → upload times.
 *
 * A list rather than a single value because filenames are not unique across the
 * archive — three stems (IMG_8165, IMG_3124, lines) name a photo in two different
 * years, and a phone that has wrapped its counter will produce more. Which
 * timestamp belongs to which file is settled per photo, in `pickTime`.
 */
function uploadTimes(xml) {
  const times = new Map()
  for (const [, ms, , name] of xml.matchAll(
    /content\/v1\/[^/]+\/(\d{13})-([A-Z0-9]+)\/([^"'<>\s]+)/g,
  )) {
    const stem = decodeURIComponent(name).replace(/\.[^.]+$/, '')
    const list = times.get(stem)
    if (list) {
      if (!list.includes(Number(ms))) list.push(Number(ms))
    } else {
      times.set(stem, [Number(ms)])
    }
  }
  return times
}

/**
 * The upload time most likely to be this photo's: the one landing closest to the
 * year it's filed under, earliest first among equals. With a single candidate —
 * which is the case for all but a handful — this just returns it.
 */
function pickTime(candidates, year) {
  const target = Number(year)
  return [...candidates].sort((a, b) => {
    const distance =
      Math.abs(new Date(a).getUTCFullYear() - target) - Math.abs(new Date(b).getUTCFullYear() - target)
    return distance !== 0 ? distance : a - b
  })[0]
}

/** Unix ms → the zoneless wall clock the manifest stores, in UTC. */
function toWallClock(ms) {
  return new Date(ms).toISOString().slice(0, 19)
}

async function main() {
  if (!existsSync(EXPORT)) {
    console.error(`✗ ${path.relative(ROOT, EXPORT)} not found — nothing to backfill from.`)
    process.exit(1)
  }
  const photos = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const times = uploadTimes(await readFile(EXPORT, 'utf8'))
  console.log(`  ${times.size} uploaded file(s) in the export`)

  let filled = 0
  const unmatched = []
  for (const photo of photos) {
    // Only the placeholder is up for replacement — see the header.
    if (!photo.approx || photo.date !== approxDateForYear(photo.year)) continue
    const stem = photo.src.split('/').pop().replace(/\.[^.]+$/, '')
    const candidates = times.get(stem)
    if (!candidates) {
      unmatched.push(photo.src)
      continue
    }
    photo.date = toWallClock(pickTime(candidates, photo.year))
    filled++
  }

  photos.sort(byNewest)
  console.log(`  ${filled} date(s) recovered, ${unmatched.length} left at the year placeholder`)
  for (const src of unmatched.slice(0, 20)) console.log(`    · ${src}`)
  if (unmatched.length > 20) console.log(`    …and ${unmatched.length - 20} more`)

  if (DRY_RUN) {
    console.log('\n· dry run — nothing written')
    return
  }
  await writeFile(MANIFEST, JSON.stringify(photos, null, 2) + '\n')
  console.log('\n✓ updated src/lib/photos.json')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
