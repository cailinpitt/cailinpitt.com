#!/usr/bin/env node
// Turn a Letterboxd CSV export into SQL for the watching Worker's D1 database.
//
//   1. letterboxd.com/settings/data → "Export your data" → unzip it
//   2. node scripts/watching-backfill.mjs ~/Downloads/letterboxd-export/diary.csv
//   3. cd worker-watching && npx wrangler d1 execute cailinpitt-watching \
//        --remote --file=../scripts/watching-backfill.sql
//   4. npm run watching:sync            # from the repo root — recomputes `stats`
//
// This exists because the RSS feed the Worker syncs is only the last 50 diary
// entries (see worker-watching/src/letterboxd.ts). Everything before that has
// to come from the export, once.
//
// ## Why this makes network requests
//
// The export's "Letterboxd URI" column is a `boxd.it` short link, *not* a
// /film/<slug>/ url — so the film slug is not in the CSV at all. That matters
// twice over: the slug is what the page links to, and it is half of the primary
// key (`<slug>|<watched date>`, see films.id in schema.sql). Slugifying the
// title instead is wrong in both directions — Letterboxd disambiguates with a
// year (`tag-2018`, not `tag`) and handles punctuation its own way
// (`maddies-secret`, not `maddie-s-secret`) — which produces links to films that
// do not exist and a *second* row for any viewing the RSS sync already stored.
//
// So each short link is resolved to its real slug via its redirect, and the
// results are cached in scripts/.watching-slugs.json. A re-run costs nothing.
//
// Two things the CSV genuinely does not have, which the feed does: TMDB ids and
// poster urls. Backfilled films therefore render the poster placeholder, and
// there is no way to fix that from this data. Rows are written with INSERT OR
// IGNORE so a later feed sync can only add to them, never lose a rating.

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'scripts', 'watching-backfill.sql')
const CACHE = path.join(ROOT, 'scripts', '.watching-slugs.json')

/** Parallel redirect lookups. Polite; the whole export is a few hundred. */
const CONCURRENCY = 5

/** Letterboxd 403s a non-browser agent, the same as it does the RSS feed. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const source = process.argv[2]
if (!source) {
  console.error('usage: node scripts/watching-backfill.mjs <diary.csv>')
  process.exit(1)
}

/**
 * Minimal RFC 4180 reader.
 *
 * Letterboxd quotes any field containing a comma — film titles routinely do —
 * and doubles quotes inside them, so splitting on commas mangles the export in
 * exactly the cases you would not notice until a title went missing.
 */
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
      // Close the row on the first of \r, \r\n, or \n, and skip the partner.
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

/** The film slug out of any letterboxd url that contains one. */
const slugIn = (url) => url?.match(/\/film\/([^/?#]+)/)?.[1] ?? null

/**
 * Follow one `boxd.it` link to the slug it points at.
 *
 * `redirect: 'manual'` rather than letting fetch follow: the Location header is
 * the whole answer, and following it would download a full film page 373 times
 * for nothing.
 */
async function resolveSlug(uri) {
  try {
    const res = await fetch(uri, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(15_000),
    })
    return slugIn(res.headers.get('location'))
  } catch {
    return null
  }
}

/** Resolve `uris` with a small worker pool, filling `cache` as it goes. */
async function resolveAll(uris, cache) {
  const pending = uris.filter((uri) => !(uri in cache))
  if (!pending.length) return { resolved: 0, failed: 0 }

  process.stdout.write(`  resolving ${pending.length} short links`)
  let resolved = 0
  let failed = 0
  let next = 0

  async function worker() {
    while (next < pending.length) {
      const uri = pending[next++]
      const slug = await resolveSlug(uri)
      cache[uri] = slug
      if (slug) resolved++
      else failed++
      if ((resolved + failed) % 25 === 0) process.stdout.write('.')
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  process.stdout.write('\n')
  return { resolved, failed }
}

const quote = (value) =>
  value == null || value === '' ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`

const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && value !== '' ? String(parsed) : 'NULL'
}

async function main() {
  const rows = parseCsv(await readFile(source, 'utf8'))
  if (!rows.length) {
    console.error('✗ empty CSV')
    process.exit(1)
  }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (name) => header.indexOf(name)
  const iName = col('name')
  const iDate = col('watched date') >= 0 ? col('watched date') : col('date')
  const iUri = col('letterboxd uri')

  if (iName < 0 || iDate < 0) {
    console.error(`✗ not a Letterboxd diary export — columns were: ${header.join(', ')}`)
    process.exit(1)
  }

  const iYear = col('year')
  const iRating = col('rating')
  const iRewatch = col('rewatch')

  // Keep only rows that can actually be filed, before spending any requests.
  const entries = []
  let skipped = 0
  for (const row of rows.slice(1)) {
    const title = row[iName]?.trim()
    const watchedDate = row[iDate]?.trim()
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(watchedDate ?? '')) {
      skipped++
      continue
    }
    entries.push({ title, watchedDate, uri: (iUri >= 0 ? row[iUri] : '')?.trim() ?? '', row })
  }

  const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {}
  const cachedCount = Object.keys(cache).length

  // Only the short links need a lookup; a url that already names the film is
  // read directly.
  const toResolve = [
    ...new Set(entries.map((e) => e.uri).filter((uri) => uri && !slugIn(uri))),
  ]
  const { resolved, failed } = await resolveAll(toResolve, cache)
  await writeFile(CACHE, JSON.stringify(cache, null, 2))

  const statements = []
  let guessed = 0

  for (const entry of entries) {
    const slug = slugIn(entry.uri) ?? cache[entry.uri] ?? null
    if (!slug) guessed++

    // The same id the Worker derives from the feed, so a backfilled row and a
    // synced one are the same row. See films.id in worker-watching/schema.sql.
    // The fallback is a guess and will not match the feed — hence the count
    // reported at the end.
    const id = `${slug ?? entry.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}|${entry.watchedDate}`
    const rewatch = (entry.row[iRewatch] ?? '').trim().toLowerCase() === 'yes' ? 1 : 0

    statements.push(
      `INSERT OR IGNORE INTO films (id, title, year, slug, watched_date, rewatch, rating, liked) ` +
        `VALUES (${quote(id)}, ${quote(entry.title)}, ` +
        `${iYear >= 0 ? number(entry.row[iYear]) : 'NULL'}, ${quote(slug)}, ` +
        `${quote(entry.watchedDate)}, ${rewatch}, ` +
        `${iRating >= 0 ? number(entry.row[iRating]) : 'NULL'}, 0);`,
    )
  }

  const sql = [
    '-- Generated by scripts/watching-backfill.mjs. Safe to re-run: every',
    '-- statement is INSERT OR IGNORE, keyed on <slug>|<watched date>.',
    `-- Source: ${path.basename(source)} (${statements.length} entries)`,
    '',
    ...statements,
    '',
  ].join('\n')

  await writeFile(OUT, sql)

  console.log(`✓ ${statements.length} films → scripts/watching-backfill.sql`)
  if (cachedCount) console.log(`  ${cachedCount} slug(s) came from the cache`)
  if (resolved) console.log(`  ${resolved} resolved from boxd.it`)
  if (failed) console.log(`  ${failed} short link(s) would not resolve`)
  if (skipped) console.log(`  ${skipped} row(s) skipped: no title or no watched date`)
  if (guessed) {
    console.log(
      `  ⚠ ${guessed} film(s) fell back to a slug guessed from the title. Those may ` +
        `link to a film that does not exist, and can duplicate a row the RSS sync stores.`,
    )
  }
  console.log(
    '\nNext:\n  cd worker-watching && npx wrangler d1 execute cailinpitt-watching \\\n' +
      '    --remote --file=../scripts/watching-backfill.sql\n' +
      '  cd .. && npm run watching:sync   # recompute the totals in `stats`',
  )
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
