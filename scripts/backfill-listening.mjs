#!/usr/bin/env node
// One-time backfill of your entire Last.fm scrobble history into the D1 archive
// used by the /listening page.
//
// It pages through user.getRecentTracks (oldest kept as-is) and writes a single
// SQL file of batched `INSERT OR IGNORE` statements. Load it into D1 with:
//
//   cd worker-listening
//   wrangler d1 execute cailinpitt-listening --remote --file=../scripts/backfill.sql
//
// Resumable: progress is checkpointed after every page to <out>.progress.json, and
// the upper bound is frozen on the first run, so if the fetch is interrupted (the
// API 500s past its retries, you Ctrl-C, etc.) just re-run — it picks up where it
// left off instead of re-fetching all 500+ pages. Delete the .progress.json to
// force a clean restart.
//
// Idempotent: the primary key (uts, track, artist) means re-running the generated
// SQL never duplicates rows and only writes ones not already present — so a partial
// load, or hitting the free-plan 100k-writes/day cap, is safe to resume too.
//
// Required env (reuses the project .env; also accepts CLI flags):
//   LASTFM_API_KEY   create at https://www.last.fm/api/account/create
//   LASTFM_USER      your Last.fm username (default: ticketmasterceo)
//
//   LASTFM_API_KEY=… node scripts/backfill-listening.mjs
//   node scripts/backfill-listening.mjs --user someone --out scripts/backfill.sql

import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// Load .env (gitignored) if present, mirroring the other scripts.
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
const USER = args.user ?? process.env.LASTFM_USER ?? 'ticketmasterceo'
const OUT = path.resolve(ROOT, args.out ?? 'scripts/backfill.sql')
const PAGE_SIZE = 200 // Last.fm max
const BATCH = 100 // rows per multi-row INSERT statement
const DELAY_MS = 250 // be polite to the API

if (!API_KEY) {
  console.error('✗ Missing LASTFM_API_KEY. Create one at https://www.last.fm/api/account/create')
  process.exit(1)
}

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sqlStr = (v) => (v == null || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

function pickImage(images) {
  if (!Array.isArray(images)) return null
  for (const size of ['extralarge', 'large', 'medium', 'small']) {
    const hit = images.find((i) => i.size === size && i['#text'])
    if (hit) return hit['#text']
  }
  return images.find((i) => i['#text'])?.['#text'] ?? null
}

async function fetchPage(page, to) {
  const params = new URLSearchParams({
    method: 'user.getrecenttracks',
    user: USER,
    api_key: API_KEY,
    format: 'json',
    extended: '1',
    limit: String(PAGE_SIZE),
    page: String(page),
  })
  // Freeze the upper bound so pagination is stable across resumes even if new
  // scrobbles land between runs (otherwise they'd shift every page boundary).
  if (to) params.set('to', String(to))
  const res = await fetch(`${ENDPOINT}?${params}`, {
    headers: { 'user-agent': 'cailinpitt.com-listening-backfill/1.0' },
  })
  if (!res.ok) throw new Error(`Last.fm HTTP ${res.status}: ${await res.text()}`)
  const data = await res.json()
  if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message ?? ''}`)
  const rt = data.recenttracks
  const raw = rt?.track ? (Array.isArray(rt.track) ? rt.track : [rt.track]) : []
  return { raw, totalPages: Number(rt?.['@attr']?.totalPages ?? 1), total: Number(rt?.['@attr']?.total ?? 0) }
}

// Last.fm's API is flaky on deep pagination (HTTP 500 / error 8 / rate limits).
// Retry each page with exponential backoff so one blip doesn't lose the run.
const MAX_ATTEMPTS = 6
async function fetchPageRetry(page, to) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchPage(page, to)
    } catch (err) {
      lastErr = err
      if (attempt === MAX_ATTEMPTS) break
      const backoff = 1000 * 2 ** (attempt - 1) // 1s, 2s, 4s, 8s, 16s
      process.stdout.write(`\n  ⚠ page ${page} failed (${err.message.slice(0, 60)}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff / 1000}s…`)
      await sleep(backoff)
    }
  }
  throw lastErr
}

const PROGRESS = `${OUT}.progress.json`

// Turn a page of raw Last.fm tracks into batched INSERT statements (skipping the
// dateless "now playing" row, which isn't a completed scrobble).
function pageToSql(raw) {
  const rows = []
  for (const t of raw) {
    if (t['@attr']?.nowplaying === 'true' || !t.date) continue
    rows.push({
      uts: Number(t.date.uts),
      track: t.name,
      artist: t.artist?.name ?? t.artist?.['#text'] ?? '',
      album: t.album?.['#text'] || null,
      mbid: t.mbid || null,
      image: pickImage(t.image),
    })
  }
  let sql = ''
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows
      .slice(i, i + BATCH)
      .map((r) => `(${r.uts},${sqlStr(r.track)},${sqlStr(r.artist)},${sqlStr(r.album)},${sqlStr(r.mbid)},${sqlStr(r.image)})`)
      .join(',\n  ')
    sql += `INSERT OR IGNORE INTO scrobbles (uts, track, artist, album, mbid, image) VALUES\n  ${values};\n`
  }
  return { sql, count: rows.length }
}

const readProgress = async () => {
  if (!existsSync(PROGRESS) || !existsSync(OUT)) return null
  try {
    return JSON.parse(await readFile(PROGRESS, 'utf8'))
  } catch {
    return null
  }
}
const saveProgress = (p) => writeFile(PROGRESS, JSON.stringify(p), 'utf8')

function printLoadInstructions(written) {
  console.log(`\n✓ Done — ${written.toLocaleString()} rows in ${path.relative(ROOT, OUT)}`)
  console.log('\nLoad it into D1 with:')
  console.log(`  cd worker-listening`)
  console.log(`  wrangler d1 execute cailinpitt-listening --remote --file=../${path.relative(ROOT, OUT)}`)
}

async function main() {
  console.log(`Backfilling scrobbles for "${USER}"…`)

  // Resume a prior run, or start a fresh one. `to` is frozen at first-run time so
  // pagination stays identical across resumes even if new scrobbles arrive.
  let progress = await readProgress()
  if (progress) {
    console.log(
      `  resuming: page ${progress.nextPage}/${progress.totalPages} (${progress.written.toLocaleString()} rows already written)`,
    )
  } else {
    const to = Math.floor(Date.now() / 1000)
    const first = await fetchPageRetry(1, to)
    console.log(`  ${first.total.toLocaleString()} scrobbles across ${first.totalPages} pages`)
    await writeFile(
      OUT,
      `-- Generated by scripts/backfill-listening.mjs — full Last.fm history.\nPRAGMA foreign_keys=OFF;\n`,
      'utf8',
    )
    const page1 = pageToSql(first.raw)
    await appendFile(OUT, page1.sql, 'utf8')
    progress = { to, totalPages: first.totalPages, nextPage: 2, written: page1.count }
    await saveProgress(progress)
  }

  try {
    for (let page = progress.nextPage; page <= progress.totalPages; page++) {
      await sleep(DELAY_MS)
      const { raw } = await fetchPageRetry(page, progress.to)
      const { sql, count } = pageToSql(raw)
      await appendFile(OUT, sql, 'utf8')
      progress.nextPage = page + 1
      progress.written += count
      await saveProgress(progress) // checkpoint after every page
      if (page % 10 === 0 || page === progress.totalPages) {
        process.stdout.write(`\r  fetched page ${page}/${progress.totalPages} (${progress.written.toLocaleString()} rows)`)
      }
    }
  } catch (err) {
    console.error(`\n✗ Stopped after retries on page ${progress.nextPage}: ${err.message}`)
    console.error(`  Progress saved (${progress.written.toLocaleString()} rows). Re-run to resume from page ${progress.nextPage}.`)
    process.exit(1)
  }

  await rm(PROGRESS, { force: true }) // completed — clear the checkpoint
  printLoadInstructions(progress.written)
}

main().catch((err) => {
  console.error('\n✗ Backfill failed:', err.message)
  process.exit(1)
})
