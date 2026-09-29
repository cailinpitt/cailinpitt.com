// Link rot. Every saved url is re-requested about monthly on the hourly cron;
// DEAD_AFTER consecutive 404/410/unreachable results mark it dead, and the page
// then links the closest Wayback Machine snapshot instead. A snapshot is also
// requested at save time, so there's usually one from the day it was saved.
//
// Blocks (403/429) and 5xx say nothing about whether the page still exists, so
// they leave the failure count alone. The same visit backfills `words` for
// articles saved before reading time existed.

import { drain, HONEST_UA, wordCounter } from './metadata'

/** Consecutive failed checks before a row is shown as dead. store.ts reads this too. */
export const DEAD_AFTER = 2

/** Rows per pass, across both tables. Each costs 2–3 subrequests. */
const BATCH = 3

const DEADLINE_MS = 20_000
const TIMEOUT_MS = 8_000

/** Re-check interval: monthly while healthy, sooner once a check has failed. */
const HEALTHY_EVERY = 30 * 86400
const FAILING_EVERY = 3 * 86400

/** Don't check anything saved in the last week — it was just fetched at ingest. */
const MIN_AGE = 7 * 86400

type Probe = { status: 'alive'; words: number | null } | { status: 'failed' } | { status: 'unknown' }

async function probe(url: string, countWords: boolean): Promise<Probe> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'user-agent': HONEST_UA, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    // A timeout is a slow server, not a missing one; DNS or connection errors count.
    return (err as Error)?.name === 'TimeoutError' ? { status: 'unknown' } : { status: 'failed' }
  }

  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel()
    return { status: 'failed' }
  }
  if (!res.ok) {
    await res.body?.cancel()
    return { status: 'unknown' }
  }

  const html = (res.headers.get('content-type') ?? '').includes('html')
  if (!countWords || !html || !res.body) {
    await res.body?.cancel()
    return { status: 'alive', words: null }
  }

  const counter = wordCounter()
  try {
    await drain(new HTMLRewriter().on('p', counter).transform(res).body!)
  } catch {
    return { status: 'alive', words: null }
  }
  return { status: 'alive', words: counter.total() || null }
}

/** Ask the Wayback Machine to capture `url` now. Fire-and-forget from /ingest. */
export async function requestSnapshot(url: string): Promise<void> {
  try {
    const res = await fetch(`https://web.archive.org/save/${url}`, {
      headers: { 'user-agent': HONEST_UA },
    })
    await res.body?.cancel()
  } catch {
    // Best effort: the rot check looks for any snapshot, not just this one.
  }
}

/** The snapshot closest to when it was saved, or null if the archive has none. */
async function findSnapshot(url: string, savedAt: number): Promise<string | null> {
  const stamp = new Date(savedAt * 1000).toISOString().slice(0, 10).replace(/-/g, '')
  try {
    const res = await fetch(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${stamp}`,
      { headers: { 'user-agent': HONEST_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string; status?: string } }
    }
    const closest = data.archived_snapshots?.closest
    if (!closest?.available || !closest.url || !closest.status?.startsWith('2')) return null
    return closest.url.replace(/^http:/, 'https:')
  } catch {
    return null
  }
}

interface TableConfig {
  table: 'articles' | 'links'
  tsCol: 'read_at' | 'saved_at'
  hasWords: boolean
}

const TABLES: TableConfig[] = [
  { table: 'articles', tsCol: 'read_at', hasWords: true },
  { table: 'links', tsCol: 'saved_at', hasWords: false },
]

interface Due {
  id: string
  url: string
  ts: number
  checked_at: number
  failures: number
  archive_url: string | null
  words: number | null
}

export interface RotResult {
  checked: number
  failed: number
  dead: number
  archived: number
}

export async function checkRot(env: Env): Promise<RotResult> {
  const now = Math.floor(Date.now() / 1000)
  const started = Date.now()
  const result: RotResult = { checked: 0, failed: 0, dead: 0, archived: 0 }

  // Oldest-checked first across both tables, so neither starves the other.
  const due: (Due & { cfg: TableConfig })[] = []
  for (const cfg of TABLES) {
    const { results } = await env.DB.prepare(
      `SELECT id, url, ${cfg.tsCol} AS ts, checked_at, failures, archive_url,
         ${cfg.hasWords ? 'words' : 'NULL AS words'}
       FROM ${cfg.table}
       WHERE checked_at < ?1 - CASE WHEN failures > 0 THEN ?2 ELSE ?3 END
         AND ${cfg.tsCol} < ?1 - ?4
       ORDER BY checked_at LIMIT ?5`,
    )
      .bind(now, FAILING_EVERY, HEALTHY_EVERY, MIN_AGE, BATCH)
      .all<Due>()
    for (const row of results ?? []) due.push({ ...row, cfg })
  }

  for (const row of due.sort((a, b) => a.checked_at - b.checked_at).slice(0, BATCH)) {
    if (Date.now() - started > DEADLINE_MS) break
    result.checked++

    const outcome = await probe(row.url, row.cfg.hasWords && row.words == null)
    let failures = row.failures
    let archive = row.archive_url
    let words: number | null = null

    if (outcome.status === 'alive') {
      failures = 0
      words = outcome.words
    } else if (outcome.status === 'failed') {
      failures++
      result.failed++
      if (failures >= DEAD_AFTER) {
        result.dead++
        if (!archive) {
          archive = await findSnapshot(row.url, row.ts)
          if (archive) result.archived++
        }
      }
    }

    await env.DB.prepare(
      row.cfg.hasWords
        ? `UPDATE articles SET checked_at = ?2, failures = ?3, archive_url = ?4,
             words = COALESCE(words, ?5) WHERE id = ?1`
        : `UPDATE links SET checked_at = ?2, failures = ?3, archive_url = ?4 WHERE id = ?1`,
    )
      .bind(...[row.id, now, failures, archive, ...(row.cfg.hasWords ? [words] : [])])
      .run()
  }

  return result
}
