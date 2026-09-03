#!/usr/bin/env node
// Trigger the activity Worker's sync (POST /sync).
//
//   npm run moving:sync               # one incremental pass
//   npm run moving:sync -- --backfill # walk backwards until history runs out
//   npm run moving:sync -- --refresh  # re-pull everything already stored
//   npm run moving:sync -- --recompute # rebuild totals from the archive, no Strava call
//   npm run moving:sync -- --api http://localhost:8787
//
// Needs MOVING_ADMIN_TOKEN in .env — the same value stored on the Worker as
// the ADMIN_TOKEN secret (`cd worker-moving && npx wrangler secret put
// ADMIN_TOKEN`). Cloudflare secrets are write-only, so .env is the only place
// you can read it back from; if the two drift, /sync returns 401.
//
// --backfill exists as a fallback. The normal way to seed the archive is
// scripts/moving-backfill.mjs against a bulk export, which costs no API
// requests at all; this walks the same history through the API, a PAGE_BUDGET
// at a time, and is worth using only if the export is unavailable.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* fall back to the ambient environment */
}

const args = process.argv.slice(2)
const BACKFILL = args.includes('--backfill')
const REFRESH = args.includes('--refresh')
const RECOMPUTE = args.includes('--recompute')
const apiArg = args.indexOf('--api')
const API =
  (apiArg >= 0 ? args[apiArg + 1] : process.env.MOVING_API) ?? 'https://moving.cailinpitt.com'

/** Politeness between passes, not a limit. */
const DELAY_MS = 2000

/** Hard stop, so a bug can't turn this into an unbounded loop. */
const MAX_PASSES = 60

const TOKEN = process.env.MOVING_ADMIN_TOKEN
if (!TOKEN) {
  console.error("✗ Missing MOVING_ADMIN_TOKEN in .env (the Worker's ADMIN_TOKEN secret).")
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function sync(page) {
  const query = RECOMPUTE
    ? '?recompute=1'
    : REFRESH
      ? `?refresh=1&page=${page}`
      : BACKFILL
        ? '?backfill=1'
        : ''
  const url = `${API}/sync${query}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = await res.text()

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    // A non-JSON body means it never reached the handler — 401, 404, an edge error.
    throw new Error(`HTTP ${res.status}: ${body.trim() || '(empty)'}`)
  }
  if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`)
  return parsed
}

async function main() {
  const mode = RECOMPUTE
    ? ' (recompute)'
    : REFRESH
      ? ' (refresh)'
      : BACKFILL
        ? ' (backfill)'
        : ''
  console.log(`→ ${API}/sync${mode}`)

  if (RECOMPUTE) {
    const result = await sync(1)
    console.log(`  ${result.recomputed ? 'totals rebuilt' : 'nothing to do'}`)
    return
  }

  let page = 1
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const result = await sync(page)
    console.log(
      `  pass ${String(pass).padStart(2)}  ` +
        `+${result.added} new of ${result.seen} seen` +
        (REFRESH ? `  (through page ${result.page})` : ''),
    )

    if (!BACKFILL && !REFRESH) return
    if (result.complete) {
      console.log(`\n✓ ${REFRESH ? 'every stored activity re-pulled' : 'history walked to the end'}`)
      return
    }
    // The Worker reports the last page it fetched; resume on the next one.
    page = (result.page ?? page) + 1
    await sleep(DELAY_MS)
  }
  console.log(`\n! stopped after ${MAX_PASSES} passes`)
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`)
  process.exit(1)
})
