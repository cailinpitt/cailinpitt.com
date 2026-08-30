#!/usr/bin/env node
// Concert Archives CSV export -> src/lib/concerts.json.
//
//   node scripts/concerts-import.mjs ~/Downloads/"<export>.csv"
//
// No API exists, so this is the only ingest path. Merges by id instead of
// overwriting, so a partial export can't drop a show.

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src', 'lib', 'concerts.json')

try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* no .env — fall back to whatever is already in the environment */
}

const CONCERT_ARCHIVES_USER_NAME_SLUG = process.env.CONCERT_ARCHIVES_USER_NAME_SLUG

const source = process.argv[2]
if (!source) {
  console.error('usage: node scripts/concerts-import.mjs <export.csv>')
  process.exit(1)
}

if (!CONCERT_ARCHIVES_USER_NAME_SLUG) {
  console.error('✗ Missing CONCERT_ARCHIVES_USER_NAME_SLUG. Add it to .env')
  process.exit(1)
}

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }

  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

function isoDate(value) {
  const match = value?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!match) return null
  const [, m, d, y] = match
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

function splitArtists(value) {
  return (value ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
}

function idFromUrl(url) {
  const match = url?.trim().match(/\/concerts\/([^/?#]+)/)
  return match ? match[1] : null
}

const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

async function main() {
  const rows = parseCsv(await readFile(source, 'utf8'))
  if (!rows.length) {
    console.error('✗ empty CSV')
    process.exit(1)
  }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (name) => header.indexOf(name)
  const iStart = col('start date')
  const iStatus = col('status')
  const iName = col('concert name')
  const iSeen = col('bands seen')
  const iVenue = col('venue')
  const iLocation = col('location')
  const iUrl = col('url')

  if (iStart < 0 || iStatus < 0 || iSeen < 0) {
    console.error(`✗ not a Concert Archives export — columns were: ${header.join(', ')}`)
    process.exit(1)
  }

  const existing = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : []
  const byId = new Map(existing.map((c) => [c.id, c]))

  let added = 0
  let updated = 0
  let skippedUpcoming = 0
  let skippedBad = 0

  for (const row of rows.slice(1)) {
    if ((row[iStatus] ?? '').trim() !== 'Past') {
      skippedUpcoming++
      continue
    }

    const date = isoDate(row[iStart])
    const artists = splitArtists(row[iSeen])
    if (!date || !artists.length) {
      skippedBad++
      continue
    }

    const url = (iUrl >= 0 ? row[iUrl] : '')?.trim().replace(CONCERT_ARCHIVES_USER_NAME_SLUG + '/', '') || ''
    const name = (iName >= 0 ? row[iName] : '')?.trim() || null
    const venue = (row[iVenue] ?? '').trim()
    const location = (iLocation >= 0 ? row[iLocation] : '')?.trim() || ''
    const id = idFromUrl(url) ?? slugify(`${date}-${venue}-${artists.join('-')}`)

    const concert = { id, date, name, artists, venue, location, url: url || null }
    if (byId.has(id)) updated++
    else added++
    byId.set(id, concert)
  }

  const concerts = [...byId.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0
  })

  await writeFile(OUT, JSON.stringify(concerts, null, 2) + '\n')

  console.log(`✓ ${concerts.length} concert(s) → src/lib/concerts.json`)
  if (added) console.log(`  ${added} new`)
  if (updated) console.log(`  ${updated} updated`)
  if (skippedUpcoming) console.log(`  ${skippedUpcoming} upcoming show(s) skipped`)
  if (skippedBad) console.log(`  ${skippedBad} row(s) skipped: missing date or artist`)
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
