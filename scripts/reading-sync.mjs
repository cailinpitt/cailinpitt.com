#!/usr/bin/env node
// Trigger the reading Worker's Hardcover sync (POST /sync).
//
//   npm run reading:sync              # one pass
//   npm run reading:sync -- --covers  # keep going until cover mirroring is done
//   npm run reading:sync -- --api http://localhost:8787
//
// Needs READING_ADMIN_TOKEN in .env — the same value stored on the Worker as the
// ADMIN_TOKEN secret (`cd worker-reading && npx wrangler secret put ADMIN_TOKEN`).
// Cloudflare secrets are write-only, so .env is the only place you can read it
// back from; if the two drift, /sync returns 401 and you just re-put both.
//
// Why --covers exists: a free-plan Worker invocation gets 50 subrequests and each
// cover costs 2, so only MIRROR_BUDGET (18) covers are mirrored per run and the
// rest carry over. This loops until they stop coming down. Everything else about
// the sync is idempotent — it's a full replace — so extra passes are harmless.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* fall back to the ambient environment */
}

const args = process.argv.slice(2)
const COVERS = args.includes('--covers')
const apiArg = args.indexOf('--api')
const API = (apiArg >= 0 ? args[apiArg + 1] : process.env.READING_API) ?? 'https://reading.cailinpitt.com'

/** Hardcover allows 60 requests/minute and each pass spends ~6 of them. */
const DELAY_MS = 6000

/** Hard stop, so a bug can't turn this into an unbounded loop. */
const MAX_PASSES = 60

const TOKEN = process.env.READING_ADMIN_TOKEN
if (!TOKEN) {
  console.error('✗ Missing READING_ADMIN_TOKEN in .env (the Worker\'s ADMIN_TOKEN secret).')
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
        `${result.books} books / ${result.rows} rows  ` +
        `+${result.coversMirrored} covers, ${result.coversRemaining} remaining`,
    )

    if (!COVERS) return
    if (result.coversRemaining === 0) {
      console.log('\n✓ all covers mirrored')
      return
    }
    // Some books have no cover url on Hardcover at all, so the remainder can
    // plateau above zero. Stop rather than loop on images that will never land.
    if (previous !== null && result.coversRemaining >= previous) {
      console.log(
        `\n✓ done — ${result.coversRemaining} cover(s) could not be mirrored ` +
          `(no image on Hardcover, or the fetch failed). Those render a placeholder.`,
      )
      return
    }
    previous = result.coversRemaining
    await sleep(DELAY_MS)
  }
  console.log(`\n! stopped after ${MAX_PASSES} passes`)
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`)
  process.exit(1)
})
