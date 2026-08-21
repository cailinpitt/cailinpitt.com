#!/usr/bin/env node
// Turn a Strava bulk export into SQL for the activity Worker's D1 database.
//
//   1. strava.com/settings/privacy → "Download or Delete Your Account" →
//      request an archive, unzip it
//   2. node scripts/moving-backfill.mjs ~/Downloads/export_XXXXXXXX/activities.csv
//   3. cd worker-moving && npx wrangler d1 execute cailinpitt-moving \
//        --remote --file=../scripts/moving-backfill.sql
//   4. npm run moving:sync            # from the repo root — recomputes `stats`
//
// This exists so the archive starts complete. The live API could walk the whole
// history too (see the backfill mode in worker-moving/src/sync.ts), but that
// is thousands of requests against a 1,000/day limit, and the export is already
// sitting on disk.
//
// ## Columns
//
// activities.csv repeats several headers — "Distance", "Elapsed Time" and
// "Max Heart Rate" each appear twice. The first copy is formatted for display
// in whatever units the account prefers; the later copy is the raw metric one
// (meters, seconds). Reading by name would silently pick the first. So columns
// are resolved by *last* index, and distance is treated as meters.
//
// Rows are INSERT OR IGNORE so a later API sync can only correct them, never be
// overwritten by this older snapshot.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'scripts', 'moving-backfill.sql')

/** Matches TZ_OFFSET_SECONDS in worker-moving/wrangler.jsonc (US Central, DST). */
const TZ_OFFSET_SECONDS = -18000

const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.280839895

// Mirrors kindOf() in worker-moving/src/strava.ts. The export writes the
// legacy `type` vocabulary, which overlaps but is not identical to sport_type —
// notably "Weight Training" with a space, and "EBikeRide" as "E-Bike Ride".
const KINDS = {
  Ride: 'ride',
  'Gravel Ride': 'ride',
  'Mountain Bike Ride': 'ride',
  'Virtual Ride': 'ride',
  'E-Bike Ride': 'ebike',
  'E-Mountain Bike Ride': 'ebike',
  'Weight Training': 'lift',
  Crossfit: 'lift',
  Walk: 'walk',
  Hike: 'walk',
  Run: 'run',
  'Trail Run': 'run',
  Yoga: 'yoga',
  'Rock Climb': 'climb',
  'Rock Climbing': 'climb',
  Dance: 'dance',
}

const kindOf = (type) => KINDS[type] ?? 'other'

/** Strava writes sport_type-style names without spaces; normalize for storage. */
const compact = (type) => type.replace(/[\s-]/g, '')

function parseCSV(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') {
      field += c
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * "Aug 5, 2026, 11:11:37 AM" → unix seconds.
 *
 * The export writes this in UTC regardless of where the activity happened.
 */
function parseDate(raw) {
  const ms = Date.parse(raw.replace(/,/g, '') + ' UTC')
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`

async function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('Usage: node scripts/moving-backfill.mjs <path to activities.csv>')
    process.exit(1)
  }

  const rows = parseCSV(await readFile(input, 'utf8'))
  const header = rows[0]

  // Last index wins — see the note at the top about repeated headers.
  const at = (name) => header.lastIndexOf(name)
  const columns = {
    id: header.indexOf('Activity ID'),
    date: header.indexOf('Activity Date'),
    name: header.indexOf('Activity Name'),
    type: header.indexOf('Activity Type'),
    elapsed: at('Elapsed Time'),
    moving: at('Moving Time'),
    distance: at('Distance'),
    elevation: at('Elevation Gain'),
    commute: header.indexOf('Commute'),
  }
  for (const [key, index] of Object.entries(columns)) {
    if (index < 0) {
      console.error(`✗ activities.csv has no column for "${key}"`)
      process.exit(1)
    }
  }

  const number = (row, index) => {
    const value = Number(row[index])
    return Number.isFinite(value) ? value : 0
  }

  const statements = []
  const counts = {}
  let skipped = 0

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const id = row[columns.id]?.trim()
    const startedAt = parseDate(row[columns.date] ?? '')
    if (!id || !/^\d+$/.test(id) || startedAt === null) {
      skipped++
      continue
    }

    const type = (row[columns.type] || 'Workout').trim()
    const kind = kindOf(type)
    counts[kind] = (counts[kind] ?? 0) + 1

    // The export has no local timestamp — only a UTC one — so the calendar date
    // is derived with a fixed offset. That is wrong across DST and anywhere but
    // home, so it is only a starting point: `npm run moving:sync -- --refresh`
    // rewrites every row with Strava's own per-activity local date.
    const startDate = new Date((startedAt + TZ_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10)
    const meters = number(row, columns.distance)
    const distanceMi = Math.round((meters / METERS_PER_MILE) * 100) / 100
    const elevationFt = Math.round(number(row, columns.elevation) * FEET_PER_METER)

    statements.push(
      'INSERT OR IGNORE INTO activities (id, name, sport_type, kind, start_date, started_at, ' +
        'distance_mi, elevation_ft, moving_time, elapsed_time, trainer, commute) VALUES (' +
        [
          sqlString(id),
          sqlString(row[columns.name] || type),
          sqlString(compact(type)),
          sqlString(kind),
          sqlString(startDate),
          startedAt,
          distanceMi,
          elevationFt,
          Math.round(number(row, columns.moving)),
          Math.round(number(row, columns.elapsed)),
          0,
          /^(true|1)$/i.test(row[columns.commute] ?? '') ? 1 : 0,
        ].join(', ') +
        ');',
    )
  }

  const header_ = [
    '-- Generated by scripts/moving-backfill.mjs. Safe to re-run: every',
    '-- statement is INSERT OR IGNORE, keyed on the Strava activity id.',
    `-- Source: ${path.basename(input)} (${statements.length} activities)`,
    '',
  ].join('\n')

  await writeFile(OUT, header_ + statements.join('\n') + '\n')

  console.log(`✓ ${statements.length} activities → scripts/moving-backfill.sql`)
  const tally = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}`)
    .join(' · ')
  console.log(`  ${tally}`)
  if (skipped) console.log(`  ${skipped} row(s) skipped (no id or unparseable date)`)
  console.log('\nNext:')
  console.log('  cd worker-moving && npx wrangler d1 execute cailinpitt-moving \\')
  console.log('    --remote --file=../scripts/moving-backfill.sql')
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`)
  process.exit(1)
})
