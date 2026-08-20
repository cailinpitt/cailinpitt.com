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
  // Projection of the current year's period blob. Rides along in the bundle
  // rather than its own endpoint — a separate request would cost a Worker
  // invocation to deliver 21KB when the page reads five numbers. Absent when
  // the year blob isn't built yet.
  year?: {
    key: string
    scrobbles: number
    artists: number
    hours: number
    newArtists: number
    /** Null unless enough of the year is classified to name one. */
    topGenre: string | null
  } | null
}

// Bucket a scrobble into a local calendar day using a fixed UTC offset. Kept
// consistent with the SQL heatmap query below so the two never disagree.
export function localDay(uts: number, offsetSeconds: number): string {
  return new Date((uts + offsetSeconds) * 1000).toISOString().slice(0, 10)
}

/** How many rows each "top" list carries. Ten made the three columns too busy. */
const TOP_N = 5

/** Top-N by play count, ties broken on the label so the order is stable. */
function topOf<T>(
  counts: Map<string, { count: number; image: string | null; label: string; row: T }>,
): (T & { count: number; image: string | null })[] {
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, TOP_N)
    .map((e) => ({ ...e.row, count: e.count, image: e.image }))
}

// Used to be 8 SQL aggregates (7d+30d), each re-reading overlapping rows —
// ~10k rows/refresh. Fetching the 30-day window once (~2k rows) and folding
// both windows out of it in JS cuts queries 8→1 and rows 5x, and removes the
// INDEXED BY hazard since there's no GROUP BY for the planner to mis-satisfy.
export function windowStats(rows: Scrobble[], since: number, days: number): StatWindow {
  const artists = new Map<string, { count: number; image: string | null; label: string; row: { name: string } }>()
  const albums = new Map<string, { count: number; image: string | null; label: string; row: { album: string; artist: string } }>()
  const tracks = new Map<string, { count: number; image: string | null; label: string; row: { track: string; artist: string } }>()

  let scrobbles = 0
  const albumKeys = new Set<string>()

  const bump = <T>(
    map: Map<string, { count: number; image: string | null; label: string; row: T }>,
    key: string,
    label: string,
    row: T,
    image: string | null,
  ) => {
    const hit = map.get(key)
    if (hit) {
      hit.count++
      // Match SQL's MAX(image): keep the largest, so a row with null art doesn't
      // wipe out cover art seen on another play of the same thing.
      if (image && (!hit.image || image > hit.image)) hit.image = image
    } else {
      map.set(key, { count: 1, image, label, row })
    }
  }

  for (const r of rows) {
    if (r.uts < since) continue
    scrobbles++
    bump(artists, r.artist, r.artist, { name: r.artist }, r.image)
    bump(tracks, `${r.track}${r.artist}`, r.track, { track: r.track, artist: r.artist }, r.image)
    if (r.album) {
      bump(albums, `${r.album}${r.artist}`, r.album, { album: r.album, artist: r.artist }, r.image)
      albumKeys.add(r.album)
    }
  }

  return {
    scrobbles,
    artists: artists.size,
    // COUNT(DISTINCT album) in the old SQL counted album *names*, not name+artist.
    albums: albumKeys.size,
    tracks: tracks.size,
    perDay: Math.round((scrobbles / days) * 10) / 10,
    topArtists: topOf(artists) as ArtistStat[],
    topAlbums: topOf(albums) as AlbumStat[],
    topTracks: topOf(tracks) as TrackStat[],
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

// Archive's heaviest day is ~155 scrobbles; a heavier one just splits across
// two pages and the client re-merges same-dated days.
const ROWS_PER_DAY = 250

/** Hard ceiling on one /days response, whatever `limit` asks for. */
const MAX_DAY_ROWS = 900

/** Older per-day logs for pagination (?before=<uts>). */
export async function fetchOlderDays(
  db: D1Database,
  offset: number,
  before: number,
  maxDays: number,
): Promise<{ days: DayLog[]; nextBefore: number | null }> {
  // Chunk scales to what was asked for, not a flat 2,000 (on-this-day wants a
  // single day). Row cap rather than time bound, so silent days cost nothing —
  // the index walk just finds no rows for them. MAX_DAY_ROWS caps the open-ended
  // range too: maxDays*ROWS_PER_DAY hits 3,500 for /timeline's 14 days, which at
  // scale would burn a day's D1 budget in ~1,400 requests; 900 still covers 14
  // days at this archive's ~51/day, and heavier stretches just paginate again.
  const limit = Math.min(maxDays * ROWS_PER_DAY, MAX_DAY_ROWS)
  const rows = await db
    .prepare(`SELECT ${ROW_COLS} FROM scrobbles WHERE uts < ?1 ORDER BY uts DESC LIMIT ?2`)
    .bind(before, limit)
    .all<Scrobble>()

  const grouped = groupDays(rows.results, offset)
  const days = grouped.slice(0, maxDays)
  // More to load if we filled the page, or the chunk itself was truncated.
  const more = grouped.length > maxDays || rows.results.length === limit
  const last = days.at(-1)
  const nextBefore = more && last ? last.tracks.at(-1)!.uts : null
  return { days, nextBefore }
}

// 7d + 30d windows plus the recent logs from a single query: the 30-day window
// (~2k rows) strictly contains both, so one fetch replaces nine queries.
export async function computeStats(
  db: D1Database,
  env: Env,
): Promise<{ windows: Bundle['windows']; recentDays: DayLog[]; nextBefore: number | null }> {
  const offset = Number(env.TZ_OFFSET_SECONDS) || 0
  const now = Math.floor(Date.now() / 1000)
  const recentDayCount = 10

  const all = await db
    .prepare(`SELECT ${ROW_COLS} FROM scrobbles WHERE uts >= ?1 ORDER BY uts DESC`)
    .bind(now - 30 * DAY)
    .all<Scrobble>()

  const window7 = windowStats(all.results, now - 7 * DAY, 7)
  const window30 = windowStats(all.results, now - 30 * DAY, 30)

  // The log needs 11 days, well inside the 30 already fetched.
  const logRows = { results: all.results.filter((r) => r.uts >= now - (recentDayCount + 1) * DAY) }
  const recentDays = groupDays(logRows.results, offset).slice(0, recentDayCount)
  const nextBefore = recentDays.at(-1)?.tracks.at(-1)?.uts ?? null

  return { windows: { '7d': window7, '30d': window30 }, recentDays, nextBefore }
}

// Last ~53 weeks for the calendar heatmap. The only query that scans a year of
// rows, hence the slow ~6h cadence. Day expression matches localDay()'s offset.
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
