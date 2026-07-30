// Everything the /listening page reads is derived here from the D1 archive. The
// cron recomputes this bundle each run and stashes it in KV, so page reads never
// touch D1 or Last.fm.

import type { NowPlaying, Scrobble } from './lastfm'

const DAY = 86_400

export interface ArtistStat {
  name: string
  count: number
  image: string | null
}
export interface AlbumStat {
  album: string
  artist: string
  count: number
  image: string | null
}
export interface TrackStat {
  track: string
  artist: string
  count: number
  image: string | null
}

export interface StatWindow {
  scrobbles: number
  artists: number
  albums: number
  tracks: number
  /** Average scrobbles per day across the window. */
  perDay: number
  topArtists: ArtistStat[]
  topAlbums: AlbumStat[]
  topTracks: TrackStat[]
}

export interface DayLog {
  date: string // YYYY-MM-DD (local)
  count: number
  tracks: Scrobble[]
}

export interface Bundle {
  updatedAt: number
  user: string
  totalScrobbles: number
  nowPlaying: NowPlaying | null
  lastPlayed: Scrobble | null
  windows: Record<'7d' | '30d', StatWindow>
  /** Per-day counts for the last year, for a calendar heatmap. */
  heatmap: { from: string; to: string; days: Record<string, number> }
  /** Full per-day track logs, newest first. */
  recentDays: DayLog[]
  /** Cursor for /days pagination: fetch older logs with ?before=<uts>. */
  nextBefore: number | null
}

// Bucket a scrobble into a local calendar day using a fixed UTC offset. Kept
// consistent with the SQL heatmap query below so the two never disagree.
export function localDay(uts: number, offsetSeconds: number): string {
  return new Date((uts + offsetSeconds) * 1000).toISOString().slice(0, 10)
}

/** How many rows each "top" list carries. Ten made the three columns too busy. */
const TOP_N = 5

async function windowStats(db: D1Database, since: number, days: number): Promise<StatWindow> {
  const counts = await db
    .prepare(
      `SELECT COUNT(*)                                            AS scrobbles,
              COUNT(DISTINCT artist)                              AS artists,
              COUNT(DISTINCT CASE WHEN album <> '' THEN album END) AS albums,
              COUNT(DISTINCT track || char(31) || artist)         AS tracks
         FROM scrobbles WHERE uts >= ?1`,
    )
    .bind(since)
    .first<{ scrobbles: number; artists: number; albums: number; tracks: number }>()

  const topArtists = await db
    .prepare(
      `SELECT artist AS name, COUNT(*) AS count, MAX(image) AS image
         FROM scrobbles WHERE uts >= ?1
        GROUP BY artist ORDER BY count DESC, name LIMIT ?2`,
    )
    .bind(since, TOP_N)
    .all<ArtistStat>()

  const topAlbums = await db
    .prepare(
      `SELECT album, artist, COUNT(*) AS count, MAX(image) AS image
         FROM scrobbles WHERE uts >= ?1 AND album <> ''
        GROUP BY album, artist ORDER BY count DESC, album LIMIT ?2`,
    )
    .bind(since, TOP_N)
    .all<AlbumStat>()

  const topTracks = await db
    .prepare(
      `SELECT track, artist, COUNT(*) AS count, MAX(image) AS image
         FROM scrobbles WHERE uts >= ?1
        GROUP BY track, artist ORDER BY count DESC, track LIMIT ?2`,
    )
    .bind(since, TOP_N)
    .all<TrackStat>()

  const scrobbles = counts?.scrobbles ?? 0
  return {
    scrobbles,
    artists: counts?.artists ?? 0,
    albums: counts?.albums ?? 0,
    tracks: counts?.tracks ?? 0,
    perDay: Math.round((scrobbles / days) * 10) / 10,
    topArtists: topArtists.results,
    topAlbums: topAlbums.results,
    topTracks: topTracks.results,
  }
}

// Group a flat, newest-first row list into per-day logs (JS-side so it shares the
// exact localDay() bucketing used everywhere else).
export function groupDays(rows: Scrobble[], offset: number): DayLog[] {
  const out: DayLog[] = []
  let current: DayLog | null = null
  for (const row of rows) {
    const date = localDay(row.uts, offset)
    if (!current || current.date !== date) {
      current = { date, count: 0, tracks: [] }
      out.push(current)
    }
    current.count++
    current.tracks.push(row)
  }
  return out
}

const ROW_COLS = 'uts, track, artist, album, mbid, image'

/** All-time count — used to seed the KV counter when it's missing. */
export async function countScrobbles(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM scrobbles').first<{ n: number }>()
  return row?.n ?? 0
}

/** Newest scrobble in the archive (read-path fallback for "last played"). */
export async function fetchLastPlayed(db: D1Database): Promise<Scrobble | null> {
  return (
    (await db.prepare(`SELECT ${ROW_COLS} FROM scrobbles ORDER BY uts DESC LIMIT 1`).first<Scrobble>()) ??
    null
  )
}

/** Older per-day logs for pagination (?before=<uts>). */
export async function fetchOlderDays(
  db: D1Database,
  offset: number,
  before: number,
  maxDays: number,
): Promise<{ days: DayLog[]; nextBefore: number | null }> {
  // Pull a generous chunk of rows below the cursor, then slice to whole days.
  const rows = await db
    .prepare(`SELECT ${ROW_COLS} FROM scrobbles WHERE uts < ?1 ORDER BY uts DESC LIMIT 2000`)
    .bind(before)
    .all<Scrobble>()

  const grouped = groupDays(rows.results, offset)
  const days = grouped.slice(0, maxDays)
  // More to load if we filled the page, or the chunk itself was truncated.
  const more = grouped.length > maxDays || rows.results.length === 2000
  const last = days.at(-1)
  const nextBefore = more && last ? last.tracks.at(-1)!.uts : null
  return { days, nextBefore }
}

/**
 * 7d + 30d windows plus the recent per-day logs. Recomputed on the "heavy"
 * cadence (every ~15 min): each query is bounded by the `uts` index, so it reads
 * only rows inside the window, never the whole archive.
 */
export async function computeStats(
  db: D1Database,
  env: Env,
): Promise<{ windows: Bundle['windows']; recentDays: DayLog[]; nextBefore: number | null }> {
  const offset = Number(env.TZ_OFFSET_SECONDS) || 0
  const now = Math.floor(Date.now() / 1000)
  const recentDayCount = 10

  const [window7, window30] = await Promise.all([
    windowStats(db, now - 7 * DAY, 7),
    windowStats(db, now - 30 * DAY, 30),
  ])

  const logRows = await db
    .prepare(`SELECT ${ROW_COLS} FROM scrobbles WHERE uts >= ?1 ORDER BY uts DESC`)
    .bind(now - (recentDayCount + 1) * DAY)
    .all<Scrobble>()
  const recentDays = groupDays(logRows.results, offset).slice(0, recentDayCount)
  const nextBefore = recentDays.at(-1)?.tracks.at(-1)?.uts ?? null

  return { windows: { '7d': window7, '30d': window30 }, recentDays, nextBefore }
}

/**
 * Per-day counts for the last ~53 weeks (calendar heatmap). This is the only
 * query that scans a year of rows, so it runs on the slow cadence (every ~6 h).
 * The SQL day expression uses the same fixed offset as localDay().
 */
export async function computeHeatmap(db: D1Database, env: Env): Promise<Bundle['heatmap']> {
  const offset = Number(env.TZ_OFFSET_SECONDS) || 0
  const now = Math.floor(Date.now() / 1000)
  const from = now - 371 * DAY

  const rows = await db
    .prepare(
      `SELECT date(uts + ?2, 'unixepoch') AS d, COUNT(*) AS c
         FROM scrobbles WHERE uts >= ?1 GROUP BY d`,
    )
    .bind(from, offset)
    .all<{ d: string; c: number }>()

  const days: Record<string, number> = {}
  for (const r of rows.results) days[r.d] = r.c
  return { from: localDay(from, offset), to: localDay(now, offset), days }
}
