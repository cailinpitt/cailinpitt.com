// Year-in-review and on-this-day, both derived from the D1 archive.

import type { Scrobble } from './lastfm'
import type { AlbumStat, ArtistStat, TrackStat } from './stats'

const TOP_N = 10 // roomier than the 7d/30d windows: a year deserves a longer list

export interface YearReview {
  year: number
  scrobbles: number
  artists: number
  albums: number
  tracks: number
  /** Distinct local days with at least one scrobble. */
  activeDays: number
  perDay: number
  /** Artists whose first-ever play in the archive falls inside this year. */
  newArtists: number
  topArtists: ArtistStat[]
  topAlbums: AlbumStat[]
  topTracks: TrackStat[]
  /** Twelve counts, January first. */
  months: number[]
  busiestDay: { date: string; count: number } | null
  firstScrobble: Scrobble | null
  /** False while the year is still in progress. */
  complete: boolean
}

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

/** [start, end) in unix seconds for a local calendar year. */
export function yearBounds(year: number, offset: number): [number, number] {
  return [Date.UTC(year, 0, 1) / 1000 - offset, Date.UTC(year + 1, 0, 1) / 1000 - offset]
}

/** [start, end) in unix seconds for one local calendar day. */
function dayBounds(year: number, month: number, day: number, offset: number): [number, number] {
  const start = Date.UTC(year, month, day) / 1000 - offset
  return [start, start + 86_400]
}

const ROW_COLS = 'uts, track, artist, album, mbid, image'

/** Years with at least one scrobble, oldest first. */
export async function listYears(db: D1Database, offset: number): Promise<number[]> {
  // MIN/MAX on an indexed column are index seeks, not scans.
  const row = await db
    .prepare('SELECT MIN(uts) AS lo, MAX(uts) AS hi FROM scrobbles')
    .first<{ lo: number | null; hi: number | null }>()
  if (!row?.lo || !row?.hi) return []
  const first = new Date((row.lo + offset) * 1000).getUTCFullYear()
  const last = new Date((row.hi + offset) * 1000).getUTCFullYear()
  const years: number[] = []
  for (let y = first; y <= last; y++) years.push(y)
  return years
}

/**
 * Every artist's debut year → how many artists first appeared in it.
 *
 * One ~100k-row pass of the artist index answers this for *all* years at once,
 * so it is computed once and shared rather than per year. Do NOT express this
 * per-year as a correlated
 * `NOT EXISTS (SELECT 1 FROM scrobbles p WHERE p.artist = s.artist AND p.uts < ?1)`:
 * that probes per *row* instead of per distinct artist and measured at
 * **4,827,240 rows for a single year**, against a 5M/day free-tier budget.
 */
export async function computeArtistDebuts(
  db: D1Database,
  offset: number,
): Promise<Record<string, number>> {
  const rows = await db
    .prepare(
      `SELECT strftime('%Y', first_uts + ?1, 'unixepoch') AS y, COUNT(*) AS n
         FROM (SELECT artist, MIN(uts) AS first_uts FROM scrobbles GROUP BY artist)
        GROUP BY y`,
    )
    .bind(offset)
    .all<{ y: string; n: number }>()

  const out: Record<string, number> = {}
  for (const r of rows.results) out[r.y] = r.n
  return out
}

export async function computeYear(
  db: D1Database,
  offset: number,
  year: number,
  now: number,
  newArtists: number,
): Promise<YearReview> {
  const [start, end] = yearBounds(year, offset)
  const range = 'uts >= ?1 AND uts < ?2'

  const counts = await db
    .prepare(
      `SELECT COUNT(*)                                             AS scrobbles,
              COUNT(DISTINCT artist)                               AS artists,
              COUNT(DISTINCT CASE WHEN album <> '' THEN album END) AS albums,
              COUNT(DISTINCT track || char(31) || artist)          AS tracks
         FROM scrobbles WHERE ${range}`,
    )
    .bind(start, end)
    .first<{ scrobbles: number; artists: number; albums: number; tracks: number }>()

  const topArtists = await db
    .prepare(
      `SELECT artist AS name, COUNT(*) AS count, MAX(image) AS image
         FROM scrobbles WHERE ${range}
        GROUP BY artist ORDER BY count DESC, name LIMIT ?3`,
    )
    .bind(start, end, TOP_N)
    .all<ArtistStat>()

  const topAlbums = await db
    .prepare(
      `SELECT album, artist, COUNT(*) AS count, MAX(image) AS image
         FROM scrobbles WHERE ${range} AND album <> ''
        GROUP BY album, artist ORDER BY count DESC, album LIMIT ?3`,
    )
    .bind(start, end, TOP_N)
    .all<AlbumStat>()

  const topTracks = await db
    .prepare(
      `SELECT track, artist, COUNT(*) AS count, MAX(image) AS image
         FROM scrobbles WHERE ${range}
        GROUP BY track, artist ORDER BY count DESC, track LIMIT ?3`,
    )
    .bind(start, end, TOP_N)
    .all<TrackStat>()

  // One row per active day (≤366), from which months, the busiest day and the
  // active-day count all fall out — cheaper than three separate aggregations.
  const daily = await db
    .prepare(
      `SELECT date(uts + ?3, 'unixepoch') AS d, COUNT(*) AS c
         FROM scrobbles WHERE ${range} GROUP BY d ORDER BY d`,
    )
    .bind(start, end, offset)
    .all<{ d: string; c: number }>()


  const firstScrobble = await db
    .prepare(`SELECT ${ROW_COLS} FROM scrobbles WHERE ${range} ORDER BY uts LIMIT 1`)
    .bind(start, end)
    .first<Scrobble>()

  const months = new Array(12).fill(0) as number[]
  let busiestDay: YearReview['busiestDay'] = null
  for (const row of daily.results) {
    months[Number(row.d.slice(5, 7)) - 1] += row.c
    if (!busiestDay || row.c > busiestDay.count) busiestDay = { date: row.d, count: row.c }
  }

  const scrobbles = counts?.scrobbles ?? 0
  const activeDays = daily.results.length
  // Per-day over days actually elapsed, so a year in progress is not divided by 365.
  const elapsed = Math.max(1, Math.ceil((Math.min(now, end) - start) / 86_400))

  return {
    year,
    scrobbles,
    artists: counts?.artists ?? 0,
    albums: counts?.albums ?? 0,
    tracks: counts?.tracks ?? 0,
    activeDays,
    perDay: Math.round((scrobbles / elapsed) * 10) / 10,
    newArtists,
    topArtists: topArtists.results,
    topAlbums: topAlbums.results,
    topTracks: topTracks.results,
    months,
    busiestDay,
    firstScrobble: firstScrobble ?? null,
    complete: now >= end,
  }
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
