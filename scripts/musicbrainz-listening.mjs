#!/usr/bin/env node
// One-time MusicBrainz enrichment: artist country, act type, and year formed.
//
// MusicBrainz asks for one request per second, so ~4,340 artists is about 75
// minutes. The cron does one artist per pass, which would take days — this is
// the bulk path, and the cron then only keeps up with newly-heard artists.
//
//   node scripts/musicbrainz-listening.mjs
//   cd worker-listening
//   wrangler d1 execute cailinpitt-listening --remote --file=../scripts/musicbrainz.sql
//
// Accuracy: Last.fm's artist.getInfo carries the artist's MBID, which turns a
// fuzzy name search into an exact lookup. Where it has none, this falls back to
// a name search and only accepts a match scoring >= 90 — a wrong country is
// worse than a missing one, because it silently distorts the chart.
//
// Resumable and idempotent, like the other backfills.

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* ambient env */
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const API_KEY = args['api-key'] ?? process.env.LASTFM_API_KEY
const OUT = path.resolve(ROOT, args.out ?? 'scripts/musicbrainz.sql')
const PROGRESS = `${OUT}.progress.json`
// Artists worth a human glance — see the note where it is written.
const REVIEW = OUT.replace(/\.sql$/, '.review.txt')
const DB = 'cailinpitt-listening'

/** MusicBrainz asks for 1 req/sec. Stay just under it. */
const MB_DELAY_MS = Number(args.delay ?? 1100)
const LASTFM_DELAY_MS = 220
const MIN_SCORE = 90
const MAX_ATTEMPTS = 4

const MB = 'https://musicbrainz.org/ws/2'
const LASTFM = 'https://ws.audioscrobbler.com/2.0/'
const UA = 'cailinpitt.com-listening/1.0 (+https://cailinpitt.com)'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sql = (v) => (v == null || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const now = Math.floor(Date.now() / 1000)

async function getJSON(url, headers) {
  const res = await fetch(url, { headers })
  if (res.status === 404) return null
  if (res.status === 503) throw new Error('rate limited')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function retry(fn) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === MAX_ATTEMPTS) break
      await sleep(1500 * 2 ** (attempt - 1))
    }
  }
  throw lastErr
}

function shape(artist) {
  const country =
    artist.country ??
    artist.area?.['iso-3166-1-codes']?.[0] ??
    artist['begin-area']?.['iso-3166-1-codes']?.[0] ??
    null
  const begin = artist['life-span']?.begin
  const year = begin ? Number(begin.slice(0, 4)) : NaN
  return {
    mbid: artist.id ?? null,
    country,
    kind: artist.type ?? null,
    formedYear: Number.isFinite(year) && year > 1800 && year <= 2100 ? year : null,
    found: true,
  }
}

const EMPTY = { mbid: null, country: null, kind: null, formedYear: null, found: false }

async function lastfmMbid(name) {
  const q = new URLSearchParams({
    method: 'artist.getinfo',
    artist: name,
    api_key: API_KEY,
    format: 'json',
  })
  const data = await getJSON(`${LASTFM}?${q}`, { 'user-agent': UA })
  return data?.artist?.mbid || null
}

/**
 * Resolve one artist, recording *how* it was resolved.
 *
 * The method matters for review. An MBID lookup is a curated link and is almost
 * always right — measured across the top artists in this archive, it never
 * disagreed with a name search. A name search is fuzzy and is where a wrong
 * answer would come from, so those are the ones flagged for review rather than
 * cross-checking every artist (which would double an already 75-minute run).
 */
async function resolve(name) {
  let mbid = null
  if (API_KEY) {
    try {
      mbid = await retry(() => lastfmMbid(name))
    } catch {
      /* fall through to search */
    }
    await sleep(LASTFM_DELAY_MS)
  }

  if (mbid) {
    const data = await retry(() =>
      getJSON(`${MB}/artist/${encodeURIComponent(mbid)}?fmt=json`, {
        'user-agent': UA,
        accept: 'application/json',
      }),
    )
    if (data) return { ...shape(data), via: 'mbid' }
  }

  const query = encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`)
  const data = await retry(() =>
    getJSON(`${MB}/artist?query=${query}&fmt=json&limit=1`, {
      'user-agent': UA,
      accept: 'application/json',
    }),
  )
  const hit = data?.artists?.[0]
  if (!hit || (hit.score ?? 0) < MIN_SCORE) return { ...EMPTY, via: 'none' }
  return { ...shape(hit), via: 'search', score: hit.score }
}

function statement(artist, o) {
  return (
    `INSERT INTO artist_meta (artist, fetched_at, mbid, country, kind, formed_year, ` +
    `mb_fetched_at, mb_missing) VALUES (${sql(artist)}, ${now}, ${sql(o.mbid)}, ` +
    `${sql(o.country)}, ${sql(o.kind)}, ${o.formedYear ?? 'NULL'}, ${now}, ${o.found ? 0 : 1}) ` +
    `ON CONFLICT(artist) DO UPDATE SET mbid=excluded.mbid, country=excluded.country, ` +
    `kind=excluded.kind, formed_year=excluded.formed_year, ` +
    `mb_fetched_at=excluded.mb_fetched_at, mb_missing=excluded.mb_missing;`
  )
}

async function loadTargets() {
  const { stdout } = await run(
    'npx',
    [
      'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command',
      `SELECT a.artist FROM artists a LEFT JOIN artist_meta m ON m.artist = a.artist
        WHERE m.mb_fetched_at IS NULL ORDER BY a.plays DESC`,
    ],
    { cwd: path.join(ROOT, 'worker-listening'), maxBuffer: 64 * 1024 * 1024 },
  )
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('[')))
  return (parsed[0]?.results ?? []).map((r) => r.artist)
}

async function main() {
  let progress = { done: 0, found: 0 }
  if (existsSync(PROGRESS)) {
    progress = JSON.parse(await readFile(PROGRESS, 'utf8'))
    console.log(`↻ resuming from ${progress.done}`)
  } else {
    await writeFile(OUT, '-- MusicBrainz artist origins\n')
  }

  console.log('· reading work list from D1…')
  const artists = await loadTargets()
  console.log(`· ${artists.length} artists to resolve`)
  console.log(`· roughly ${Math.round((artists.length * (MB_DELAY_MS + LASTFM_DELAY_MS)) / 60000)} minutes\n`)

  for (let i = progress.done; i < artists.length; i++) {
    const artist = artists[i]
    try {
      const origin = await resolve(artist)
      await appendFile(OUT, statement(artist, origin) + '\n')
      if (origin.found) progress.found++
      // Fuzzy matches are the only ones that can be confidently wrong, so they
      // are the review list — an artist name shared by two acts (Turnstile is
      // the known case) resolves cleanly but to the wrong band.
      if (origin.via === 'search' && origin.country) {
        await appendFile(
          REVIEW,
          `${artist}\t${origin.country}\t${origin.kind ?? '-'}\t${origin.formedYear ?? '-'}\tscore=${origin.score ?? '?'}\n`,
        )
        progress.review = (progress.review ?? 0) + 1
      }
    } catch (err) {
      // Record the attempt so the queue advances past a permanently broken name.
      await appendFile(OUT, statement(artist, EMPTY) + '\n')
      process.stdout.write(`\n  ⚠ ${artist}: ${err.message}`)
    }
    progress.done = i + 1
    await writeFile(PROGRESS, JSON.stringify(progress))
    if (i % 20 === 0) {
      const pct = Math.round((progress.found / Math.max(1, progress.done)) * 100)
      process.stdout.write(`\r  ${i + 1}/${artists.length}  (${pct}% resolved)`)
    }
    await sleep(MB_DELAY_MS)
  }

  console.log(`\r  ${artists.length}/${artists.length} done — ${progress.found} resolved`)
  if (progress.review) {
    console.log(
      `\n  ${progress.review} resolved by fuzzy name search — listed in ` +
        `${path.relative(ROOT, REVIEW)}.`,
    )
    console.log('  Skim it for names shared by two acts; correct any in ORIGIN_OVERRIDES')
    console.log('  (worker-listening/src/musicbrainz.ts). Everything else needs no action.')
  }
  console.log(`\n✓ wrote ${path.relative(ROOT, OUT)}`)
  console.log('  Load it with:')
  console.log(`    cd worker-listening && wrangler d1 execute ${DB} --remote --file=../${path.relative(ROOT, OUT)}`)
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n  Re-run to resume.`)
  process.exit(1)
})
