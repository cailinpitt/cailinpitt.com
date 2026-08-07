#!/usr/bin/env node
// Triage the MusicBrainz fuzzy matches worth a human glance.
//
// scripts/musicbrainz.review.txt lists every artist resolved by name search
// rather than by MBID. That list is long and mostly fine, and its `score` column
// is useless for ranking: MusicBrainz returns 100 for any exact name match,
// including when several different acts share the name exactly. That is the
// whole failure mode — "Turnstile" matches a Spanish group at score 100.
//
// Two better signals, in order of cost:
//
//  1. **Plays.** A wrong country on a one-play artist moves no chart. Ranking by
//     play count turns ~180 entries into the handful that could actually matter.
//  2. **Name ambiguity.** Asking MusicBrainz how many acts share the name is the
//     real check — but it costs a request each, so it is opt-in and applied only
//     to the top of the ranked list.
//
//   node scripts/review-origins.mjs              # rank by plays
//   node scripts/review-origins.mjs --top 40
//   node scripts/review-origins.mjs --verify 20  # + ask MB about the top 20
//
// --verify hits MusicBrainz at 1 req/sec, so run it *after* the backfill has
// finished rather than alongside it.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REVIEW = path.join(ROOT, 'scripts', 'musicbrainz.review.txt')
const DB = 'cailinpitt-listening'
const UA = 'cailinpitt.com-listening/1.0 (+https://cailinpitt.com)'
const MB = 'https://musicbrainz.org/ws/2'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
  }
  return args
}
const args = parseArgs(process.argv.slice(2))
const TOP = Number(args.top ?? 30)
const VERIFY = args.verify ? Number(args.verify) : 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function playCounts() {
  const { stdout } = await run(
    'npx',
    [
      'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command',
      'SELECT artist, plays FROM artists',
    ],
    { cwd: path.join(ROOT, 'worker-listening'), maxBuffer: 64 * 1024 * 1024 },
  )
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('[')))
  const rows = parsed[0]?.results ?? []
  const map = new Map(rows.map((r) => [r.artist, r.plays]))
  const total = rows.reduce((sum, r) => sum + r.plays, 0)
  return { map, total }
}

/** How many MusicBrainz acts carry this exact name. >1 means the pick was a guess. */
async function candidates(name) {
  const query = encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`)
  const res = await fetch(`${MB}/artist?query=${query}&fmt=json&limit=5`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
  })
  if (!res.ok) return null
  const data = await res.json()
  const exact = (data.artists ?? []).filter(
    (a) => (a.score ?? 0) >= 100 && a.name?.toLowerCase() === name.toLowerCase(),
  )
  return exact.map((a) => ({
    country: a.country ?? a.area?.['iso-3166-1-codes']?.[0] ?? '—',
    type: a.type ?? '—',
    began: a['life-span']?.begin?.slice(0, 4) ?? '—',
    note: a.disambiguation ?? '',
  }))
}

async function main() {
  if (!existsSync(REVIEW)) {
    console.log('No review file yet — musicbrainz-listening.mjs writes it as it runs.')
    return
  }

  const lines = (await readFile(REVIEW, 'utf8')).split('\n').filter(Boolean)
  const entries = lines.map((l) => {
    const [artist, country, kind, formed] = l.split('\t')
    return { artist, country, kind, formed }
  })

  console.log(`· ${entries.length} artists were resolved by name search`)
  console.log('· reading play counts from D1…\n')
  const { map, total } = await playCounts()

  const ranked = entries
    .map((e) => ({ ...e, plays: map.get(e.artist) ?? 0 }))
    .sort((a, b) => b.plays - a.plays)

  // Everything below this is noise: even a completely wrong country moves the
  // chart by less than a tenth of a percent.
  const FLOOR = Math.max(10, Math.round(total * 0.001))
  const worth = ranked.filter((e) => e.plays >= FLOOR)

  console.log(`Ranked by plays. ${worth.length} of ${entries.length} have >= ${FLOOR} plays`)
  console.log(`(${FLOOR} plays ~ 0.1% of the archive; below that a wrong country is invisible)\n`)

  const shown = ranked.slice(0, TOP)
  const width = Math.max(...shown.map((e) => e.artist.length), 6)
  console.log(`${'artist'.padEnd(width)}  plays   share   country  type    formed`)
  console.log('─'.repeat(width + 40))
  for (const e of shown) {
    const share = ((e.plays / total) * 100).toFixed(2)
    console.log(
      `${e.artist.padEnd(width)}  ${String(e.plays).padStart(5)}  ${share.padStart(5)}%  ` +
        `${(e.country ?? '—').padEnd(7)}  ${(e.kind ?? '—').padEnd(6)}  ${e.formed ?? '—'}`,
    )
  }

  if (!VERIFY) {
    console.log(`\nTo ask MusicBrainz which of these names are ambiguous:`)
    console.log(`  node scripts/review-origins.mjs --verify 20`)
    return
  }

  console.log(`\n· checking the top ${VERIFY} for name collisions (1 req/sec)…\n`)
  let ambiguous = 0
  for (const e of ranked.slice(0, VERIFY)) {
    const hits = await candidates(e.artist)
    await sleep(1100)
    if (!hits || hits.length <= 1) continue
    ambiguous++
    console.log(`⚠ ${e.artist} — ${hits.length} acts share this name (${e.plays} plays)`)
    for (const h of hits) {
      const chosen = h.country === e.country ? ' ← chosen' : ''
      console.log(`    ${h.country.padEnd(4)} ${h.type.padEnd(8)} ${h.began.padEnd(6)} ${h.note}${chosen}`)
    }
    console.log()
  }

  if (!ambiguous) {
    console.log('No collisions in that range — every name resolved to exactly one act.')
  } else {
    console.log(`${ambiguous} to decide on. Correct any in ORIGIN_OVERRIDES:`)
    console.log('  worker-listening/src/musicbrainz.ts')
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
