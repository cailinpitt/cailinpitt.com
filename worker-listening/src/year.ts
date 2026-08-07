// On-this-day, derived from the D1 archive.
//
// The year-in-review that used to live here is gone: period blobs compute the
// same thing on the cron, and computing it again on the request path was both a
// duplicate implementation and a ~18,700-row aggregation per cache miss.
// computeArtistDebuts went with it — the `artists` summary table answers
// "discovered in this period" with an index range instead of a 100k-row scan.

import type { Scrobble } from './lastfm'

export interface OnThisDayYear {
  year: number
  count: number
  topArtist: string | null
  tracks: Scrobble[]
}

export interface OnThisDay {
  /** Local month/day this was built for, as MM-DD. */
  date: string
  years: OnThisDayYear[]
}

/** [start, end) in unix seconds for one local calendar day. */
function dayBounds(year: number, month: number, day: number, offset: number): [number, number] {
  const start = Date.UTC(year, month, day) / 1000 - offset
  return [start, start + 86_400]
}

const ROW_COLS = 'uts, track, artist, album, mbid, image'

/** Years with at least one scrobble, oldest first. */
export async function listYears(db: D1Database, offset: number): Promise<number[]> {
  // Two queries, deliberately. SQLite only optimizes a *single* MIN or MAX per
  // query into an index seek; asking for both in one statement plans
  // "SCAN scrobbles USING COVERING INDEX idx_scrobbles_uts" and measured at
  // 100,829 rows. Split, each is a "SEARCH" that touches one row.
  const [lo, hi] = await Promise.all([
    db.prepare('SELECT MIN(uts) AS v FROM scrobbles').first<{ v: number | null }>(),
    db.prepare('SELECT MAX(uts) AS v FROM scrobbles').first<{ v: number | null }>(),
  ])
  if (!lo?.v || !hi?.v) return []
  const first = new Date((lo.v + offset) * 1000).getUTCFullYear()
  const last = new Date((hi.v + offset) * 1000).getUTCFullYear()
  const years: number[] = []
  for (let y = first; y <= last; y++) years.push(y)
  return years
}

/**
 * The same calendar day in previous years. Built from a union of per-year day
 * ranges rather than `strftime('%m-%d', …) = ?`, which would scan the archive;
 * this touches only the handful of rows on those specific days.
 */
export async function computeOnThisDay(
  db: D1Database,
  offset: number,
  now: number,
  years: number[],
): Promise<OnThisDay> {
  const local = new Date((now + offset) * 1000)
  const month = local.getUTCMonth()
  const day = local.getUTCDate()
  const thisYear = local.getUTCFullYear()

  const past = years.filter((y) => y < thisYear)
  const dateKey = `${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  if (!past.length) return { date: dateKey, years: [] }

  const clauses: string[] = []
  const binds: number[] = []
  for (const y of past) {
    const [lo, hi] = dayBounds(y, month, day, offset)
    clauses.push(`(uts >= ?${binds.length + 1} AND uts < ?${binds.length + 2})`)
    binds.push(lo, hi)
  }

  const rows = await db
    .prepare(`SELECT ${ROW_COLS} FROM scrobbles WHERE ${clauses.join(' OR ')} ORDER BY uts DESC`)
    .bind(...binds)
    .all<Scrobble>()

  const byYear = new Map<number, Scrobble[]>()
  for (const row of rows.results) {
    const y = new Date((row.uts + offset) * 1000).getUTCFullYear()
    const list = byYear.get(y)
    if (list) list.push(row)
    else byYear.set(y, [row])
  }

  const out: OnThisDayYear[] = []
  for (const y of [...byYear.keys()].sort((a, b) => b - a)) {
    const tracks = byYear.get(y)!
    const plays = new Map<string, number>()
    for (const t of tracks) plays.set(t.artist, (plays.get(t.artist) ?? 0) + 1)
    const topArtist =
      [...plays.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
    out.push({ year: y, count: tracks.length, topArtist, tracks: tracks.slice(0, 5) })
  }

  return { date: dateKey, years: out }
}
