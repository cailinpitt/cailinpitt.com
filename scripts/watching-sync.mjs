#!/usr/bin/env node
// Trigger the watching Worker's Letterboxd sync (POST /sync).
//
//   npm run watching:sync              # one pass
//   npm run watching:sync -- --posters # keep going until poster mirroring is done
//   npm run watching:sync -- --api http://localhost:8787
//
// Needs WATCHING_ADMIN_TOKEN in .env — the same value stored on the Worker as
// the ADMIN_TOKEN secret (`cd worker-watching && npx wrangler secret put
// ADMIN_TOKEN`). Cloudflare secrets are write-only, so .env is the only place
// you can read it back from; if the two drift, /sync returns 401 and you just
// re-put both.
//
// Why --posters exists: a free-plan Worker invocation gets 50 subrequests and
// each poster costs 2, so only MIRROR_BUDGET (15) are mirrored per run and the
// rest carry over. This loops until they stop coming down. Everything else
// about the sync is idempotent — every write is keyed on <slug>|<watched
// date> — so extra passes are harmless.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* fall back to the ambient environment */
}

const args = process.argv.slice(2)
const POSTERS = args.includes('--posters')
const apiArg = args.indexOf('--api')
const API =
  (apiArg >= 0 ? args[apiArg + 1] : process.env.WATCHING_API) ?? 'https://watching.cailinpitt.com'

/** Letterboxd is fetched once per pass; this is politeness, not a limit. */
const DELAY_MS = 3000

/** Hard stop, so a bug can't turn this into an unbounded loop. */
const MAX_PASSES = 40

const TOKEN = process.env.WATCHING_ADMIN_TOKEN
if (!TOKEN) {
  console.error("✗ Missing WATCHING_ADMIN_TOKEN in .env (the Worker's ADMIN_TOKEN secret).")
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function sync() {
  const res = await fetch(`${API}/sync`, {
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
  console.log(`→ ${API}/sync`)

  let previous = null
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const result = await sync()
    console.log(
      `  pass ${String(pass).padStart(2)}  ` +
        `+${result.added} new of ${result.seen} in the feed  ` +
        `+${result.postersMirrored} posters, ${result.postersRemaining} remaining`,
    )

    if (!POSTERS) return
    if (result.postersRemaining === 0) {
      console.log('\n✓ all posters mirrored')
      return
    }
    // Some entries have no poster in the feed at all, so the remainder can
    // plateau above zero. Stop rather than loop on images that will never land.
    if (previous !== null && result.postersRemaining >= previous) {
      console.log(
        `\n✓ done — ${result.postersRemaining} poster(s) could not be mirrored ` +
          `(none in the feed, or the fetch failed). Those render a placeholder.`,
      )
      return
    }
    previous = result.postersRemaining
    await sleep(DELAY_MS)
  }
  console.log(`\n! stopped after ${MAX_PASSES} passes`)
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`)
  process.exit(1)
})
