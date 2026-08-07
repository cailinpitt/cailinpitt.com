#!/usr/bin/env node
// One-time enrichment of the listening archive: genre tags per artist, and track
// durations via album lookups.
//
// The cron enriches a couple of entities a minute, which would take about nine
// days to work through 4,340 artists and 8,854 albums. This does it in one pass
// in roughly an hour, then the cron only has to keep up with new arrivals.
//
// Reads the entity lists straight from D1 (cheap — the summary tables are a few
// thousand rows) and writes a SQL file, mirroring backfill-listening.mjs:
//
//   node scripts/enrich-listening.mjs
//   cd worker-listening
//   wrangler d1 execute cailinpitt-listening --remote --file=../scripts/enrich.sql
//
// Resumable: progress is checkpointed after every entity to <out>.progress.json,
// so an interrupted run picks up where it stopped instead of re-fetching.
// Idempotent: every statement is an upsert keyed on the entity.
//
// Required env (reuses the project .env):
//   LASTFM_API_KEY

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
  /* fall back to the ambient environment */
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
const OUT = path.resolve(ROOT, args.out ?? 'scripts/enrich.sql')
const PROGRESS = `${OUT}.progress.json`
const DB = 'cailinpitt-listening'

/** Last.fm tolerates ~5 req/s; stay well under it. */
const DELAY_MS = Number(args.delay ?? 220)
const MAX_ATTEMPTS = 5

if (!API_KEY) {
  console.error('✗ Missing LASTFM_API_KEY')
  process.exit(1)
}

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sql = (v) => (v == null || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const now = Math.floor(Date.now() / 1000)

async function call(params) {
  const query = new URLSearchParams({ ...params, api_key: API_KEY, format: 'json' })
  const res = await fetch(`${ENDPOINT}?${query}`, {
    headers: { 'user-agent': 'cailinpitt.com-listening-enrich/1.0' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function callRetry(params) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await call(params)
    } catch (err) {
      lastErr = err
      if (attempt === MAX_ATTEMPTS) break
      await sleep(1000 * 2 ** (attempt - 1))
    }
  }
  throw lastErr
}

/**
 * Pull the work list out of D1.
 *
 * Only entities with no meta row yet, so a re-run after a partial load doesn't
 * re-fetch what already landed. Reads the summary tables, which are small.
 */
async function loadTargets() {
  const query = async (statement) => {
    const { stdout } = await run(
      'npx',
      ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', statement],
      { cwd: path.join(ROOT, 'worker-listening'), maxBuffer: 64 * 1024 * 1024 },
    )
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('[')))
    return parsed[0]?.results ?? []
  }

  const artists = await query(
    `SELECT a.artist FROM artists a LEFT JOIN artist_meta m ON m.artist = a.artist
      WHERE m.artist IS NULL ORDER BY a.plays DESC`,
  )
  const albums = await query(
    `SELECT b.album, b.artist FROM albums b
       LEFT JOIN album_meta m ON m.album = b.album AND m.artist = b.artist
      WHERE m.album IS NULL ORDER BY b.plays DESC`,
  )
  return { artists: artists.map((r) => r.artist), albums }
}

function artistStatement(artist, tags, found) {
  return (
    `INSERT INTO artist_meta (artist, tags, fetched_at, missing) VALUES (` +
    `${sql(artist)}, ${sql(JSON.stringify(tags))}, ${now}, ${found ? 0 : 1}) ` +
    `ON CONFLICT(artist) DO UPDATE SET tags=excluded.tags, fetched_at=excluded.fetched_at, ` +
    `missing=excluded.missing;`
  )
}

function albumStatements(album, artist, info) {
  const out = [
    `INSERT INTO album_meta (album, artist, tags, fetched_at, missing) VALUES (` +
      `${sql(album)}, ${sql(artist)}, ${sql(JSON.stringify(info.tags))}, ${now}, ` +
      `${info.found ? 0 : 1}) ` +
      `ON CONFLICT(album, artist) DO UPDATE SET tags=excluded.tags, ` +
      `fetched_at=excluded.fetched_at, missing=excluded.missing;`,
  ]
  for (const track of info.tracks) {
    if (track.duration == null) continue
    out.push(
      `INSERT INTO track_meta (track, artist, duration, fetched_at) VALUES (` +
        `${sql(track.name)}, ${sql(artist)}, ${track.duration}, ${now}) ` +
        `ON CONFLICT(track, artist) DO UPDATE SET duration=excluded.duration, ` +
        `fetched_at=excluded.fetched_at;`,
    )
  }
  return out
}

async function fetchArtist(artist) {
  const data = await callRetry({ method: 'artist.gettoptags', artist })
  if (data.error === 6) return { tags: [], found: false }
  if (data.error) throw new Error(`Last.fm error ${data.error}`)
  const raw = data.toptags?.tag
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : []
  return {
    tags: list.map((t) => ({ name: String(t.name), count: Number(t.count) || 0 })),
    found: true,
  }
}

async function fetchAlbum(artist, album) {
  const data = await callRetry({ method: 'album.getinfo', artist, album })
  if (data.error === 6) return { tags: [], tracks: [], found: false }
  if (data.error) throw new Error(`Last.fm error ${data.error}`)
  const a = data.album
  const rawTags = a?.tags?.tag
  const tagList = rawTags ? (Array.isArray(rawTags) ? rawTags : [rawTags]) : []
  const rawTracks = a?.tracks?.track
  const trackList = rawTracks ? (Array.isArray(rawTracks) ? rawTracks : [rawTracks]) : []
  return {
    tags: tagList.map((t) => ({ name: String(t.name), count: Number(t.count) || 1 })),
    tracks: trackList.map((t) => {
      const seconds = Number(t.duration)
      return {
        name: String(t.name),
        duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      }
    }),
    found: true,
  }
}

async function main() {
  let progress = { artists: 0, albums: 0 }
  if (existsSync(PROGRESS)) {
    progress = JSON.parse(await readFile(PROGRESS, 'utf8'))
    console.log(`↻ resuming: ${progress.artists} artists, ${progress.albums} albums already done`)
  } else {
    await writeFile(OUT, '-- Listening enrichment (genres + durations)\n')
  }

  console.log('· reading work list from D1…')
  const { artists, albums } = await loadTargets()
  console.log(`· ${artists.length} artists, ${albums.length} albums to enrich`)

  const eta = ((artists.length + albums.length) * DELAY_MS) / 60000
  console.log(`· roughly ${Math.round(eta)} minutes at ${DELAY_MS}ms between calls\n`)

  for (let i = progress.artists; i < artists.length; i++) {
    const artist = artists[i]
    try {
      const { tags, found } = await fetchArtist(artist)
      await appendFile(OUT, artistStatement(artist, tags, found) + '\n')
    } catch (err) {
      // Record the failure so the queue moves on rather than stalling here.
      await appendFile(OUT, artistStatement(artist, [], false) + '\n')
      process.stdout.write(`\n  ⚠ ${artist}: ${err.message}`)
    }
    progress.artists = i + 1
    await writeFile(PROGRESS, JSON.stringify(progress))
    if (i % 25 === 0) process.stdout.write(`\r  artists ${i + 1}/${artists.length}`)
    await sleep(DELAY_MS)
  }
  console.log(`\r  artists ${artists.length}/${artists.length} ✓`)

  for (let i = progress.albums; i < albums.length; i++) {
    const { album, artist } = albums[i]
    try {
      const info = await fetchAlbum(artist, album)
      await appendFile(OUT, albumStatements(album, artist, info).join('\n') + '\n')
    } catch (err) {
      await appendFile(OUT, albumStatements(album, artist, { tags: [], tracks: [], found: false })[0] + '\n')
      process.stdout.write(`\n  ⚠ ${artist} — ${album}: ${err.message}`)
    }
    progress.albums = i + 1
    await writeFile(PROGRESS, JSON.stringify(progress))
    if (i % 25 === 0) process.stdout.write(`\r  albums ${i + 1}/${albums.length}`)
    await sleep(DELAY_MS)
  }
  console.log(`\r  albums ${albums.length}/${albums.length} ✓`)

  console.log(`\n✓ wrote ${path.relative(ROOT, OUT)}`)
  console.log('  Load it with:')
  console.log(`    cd worker-listening && wrangler d1 execute ${DB} --remote --file=../${path.relative(ROOT, OUT)}`)
  console.log('  Then delete the .progress.json to allow a clean re-run later.')
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`)
  console.error('  Re-run to resume from the checkpoint.')
  process.exit(1)
})
