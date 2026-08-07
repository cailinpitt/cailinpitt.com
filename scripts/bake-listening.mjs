#!/usr/bin/env node
// Bake completed listening periods into the build as static assets.
//
// A completed week/month/year can never change, so there is no reason to spend a
// Worker invocation serving it. Static assets on the host don't count against the
// Workers free-plan request ceiling at all, so this moves essentially all period
// traffic off the Worker and leaves it serving only the four live periods.
//
// Writes public/listening-data/<kind>/<key>.json. The client tries that path
// first and falls back to the API (see fetchPeriodBlob in src/lib/listening.ts),
// so a missing or stale bake is a slower path, never a broken page.
//
// **Never fails the build.** The whole point of the fallback is that an
// unreachable Worker can't stop a deploy of unrelated content, so every error
// here is a warning and a non-zero count of skipped periods.
//
//   node scripts/bake-listening.mjs
//   LISTENING_API=http://127.0.0.1:8787 node scripts/bake-listening.mjs

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'public', 'listening-data')
const API = process.env.LISTENING_API ?? 'https://listening.cailinpitt.com'

/** Give up on the whole bake rather than hang a CI job. */
const TOTAL_BUDGET_MS = 90_000
/** Per-request timeout. */
const REQUEST_MS = 10_000
/** How many blobs to fetch at once. Polite, and enough to finish in seconds. */
const CONCURRENCY = 6

const started = Date.now()
const budgetLeft = () => TOTAL_BUDGET_MS - (Date.now() - started)

async function getJSON(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  let index
  try {
    index = await getJSON(`${API}/periods.json`)
  } catch (err) {
    console.warn(`⚠ listening bake skipped: could not reach ${API} (${err.message})`)
    console.warn('  The site will fetch periods from the API at runtime instead.')
    return
  }
  if (!index) {
    console.warn('⚠ listening bake skipped: no period index published yet')
    return
  }

  // Only completed periods are baked. The live week/month/year still change, and
  // a stale copy of "this week" shipped in the build would be worse than a fetch.
  const targets = []
  for (const kind of ['y', 'm', 'w']) {
    for (const key of index[kind] ?? []) targets.push({ kind, key })
  }

  if (!targets.length) {
    console.warn('⚠ listening bake: index is empty, nothing completed yet')
    return
  }

  await Promise.all(
    ['y', 'm', 'w'].map((kind) => mkdir(path.join(OUT, kind), { recursive: true })),
  )

  let written = 0
  let skipped = 0
  const queue = [...targets]

  const worker = async () => {
    while (queue.length) {
      if (budgetLeft() <= 0) {
        skipped += queue.length
        queue.length = 0
        return
      }
      const { kind, key } = queue.shift()
      try {
        const blob = await getJSON(`${API}/p/${kind}/${key}.json`)
        // A period the cron hasn't built yet simply isn't baked this time round.
        if (!blob) {
          skipped++
          continue
        }
        // The index lists every blob in KV, which includes the live week, month
        // and year — they share the key prefix. Baking one would freeze a
        // still-changing period into the build and serve it as though it were
        // final, so trust the blob's own flag rather than the index.
        if (!blob.complete) {
          skipped++
          continue
        }
        await writeFile(path.join(OUT, kind, `${key}.json`), JSON.stringify(blob))
        written++
      } catch (err) {
        skipped++
        console.warn(`  ⚠ ${kind}/${key}: ${err.message}`)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  console.log(
    `✓ baked ${written} listening period${written === 1 ? '' : 's'}` +
      (skipped ? ` (${skipped} skipped)` : ''),
  )
}

main().catch((err) => {
  // Belt and braces: nothing in this script is allowed to fail a deploy.
  console.warn(`⚠ listening bake failed, falling back to runtime fetch: ${err.message}`)
})
