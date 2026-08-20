// Layer 1: the incremental summary tables (see schema-v2.sql).
//
// One row per artist/album/track/day instead of one per play. Everything here
// is either an index seek or a scan of a few thousand rows, which is what keeps
// discovery stats and streaks off the 101k-row archive.

import type { Scrobble } from './lastfm'
import { dayKey } from './periods'

const SEP = '\u001f'

/** 100 bound parameters per query is a hard D1 limit. */
const MAX_BINDS = 100

// Must match the threshold in backfill-returns.sql, or history and live ingest disagree.
export const RETURN_GAP = 365 * 86_400

export interface DiscoveryCounts {
  artists: number
  albums: number
  tracks: number
  newArtists: { name: string; uts: number }[]
}

// Caller must pass the RETURNING output of the archive insert, never the raw
// Last.fm page — ingest re-offers an hour of overlap, and rows dropped by
// INSERT OR IGNORE must not reach these counters or `plays` drifts upward forever.
export function summaryStatements(
  env: Env,
  inserted: Scrobble[],
  /** Each artist's last play *before* this batch — see priorLastPlay(). */
  prior: Map<string, number> = new Map(),
): D1PreparedStatement[] {
  if (!inserted.length) return []
  const offset = Number(env.TZ_OFFSET_SECONDS) || 0

  // Fold the batch first: a single pull often contains the same artist twice, and
  // one statement per play would be both slower and pointless.
  const artists = new Map<string, { first: number; last: number; plays: number }>()
  const albums = new Map<string, { album: string; artist: string; first: number; last: number; plays: number }>()
  const tracks = new Map<string, { track: string; artist: string; first: number; last: number; plays: number }>()
  const days = new Map<string, number>()

  const fold = <T extends { first: number; last: number; plays: number }>(
    map: Map<string, T>,
    key: string,
    make: () => T,
    uts: number,
  ) => {
    const hit = map.get(key)
    if (!hit) {
      map.set(key, make())
      return
    }
    hit.first = Math.min(hit.first, uts)
    hit.last = Math.max(hit.last, uts)
    hit.plays++
  }

  for (const r of inserted) {
    fold(artists, r.artist, () => ({ first: r.uts, last: r.uts, plays: 1 }), r.uts)
    fold(
      tracks,
      `${r.track}${SEP}${r.artist}`,
      () => ({ track: r.track, artist: r.artist, first: r.uts, last: r.uts, plays: 1 }),
      r.uts,
    )
    if (r.album) {
      fold(
        albums,
        `${r.album}${SEP}${r.artist}`,
        () => ({ album: r.album!, artist: r.artist, first: r.uts, last: r.uts, plays: 1 }),
        r.uts,
      )
    }
    const day = dayKey(r.uts, offset)
    days.set(day, (days.get(day) ?? 0) + 1)
  }

  const out: D1PreparedStatement[] = []

  for (const [artist, v] of artists) {
    out.push(
      env.DB.prepare(
        `INSERT INTO artists (artist, first_uts, last_uts, plays) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(artist) DO UPDATE SET
           first_uts = MIN(first_uts, excluded.first_uts),
           last_uts  = MAX(last_uts,  excluded.last_uts),
           plays     = plays + excluded.plays`,
      ).bind(artist, v.first, v.last, v.plays),
    )
  }
  for (const v of albums.values()) {
    out.push(
      env.DB.prepare(
        `INSERT INTO albums (album, artist, first_uts, last_uts, plays) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(album, artist) DO UPDATE SET
           first_uts = MIN(first_uts, excluded.first_uts),
           last_uts  = MAX(last_uts,  excluded.last_uts),
           plays     = plays + excluded.plays`,
      ).bind(v.album, v.artist, v.first, v.last, v.plays),
    )
  }
  for (const v of tracks.values()) {
    out.push(
      env.DB.prepare(
        `INSERT INTO tracks (track, artist, first_uts, last_uts, plays) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(track, artist) DO UPDATE SET
           first_uts = MIN(first_uts, excluded.first_uts),
           last_uts  = MAX(last_uts,  excluded.last_uts),
           plays     = plays + excluded.plays`,
      ).bind(v.track, v.artist, v.first, v.last, v.plays),
    )
  }
  for (const [day, plays] of days) {
    out.push(
      env.DB.prepare(
        `INSERT INTO days (day, plays) VALUES (?1, ?2)
         ON CONFLICT(day) DO UPDATE SET plays = plays + excluded.plays`,
      ).bind(day, plays),
    )
  }

  // Returns are detected against the last_uts captured *before* the artists
  // upsert above — once it lands, the gap is gone.
  for (const [artist, v] of artists) {
    const before = prior.get(artist)
    if (before === undefined || v.first - before < RETURN_GAP) continue
    out.push(
      env.DB.prepare(
        'INSERT OR REPLACE INTO returns (artist, uts, gap_days) VALUES (?1, ?2, ?3)',
      ).bind(artist, v.first, Math.floor((v.first - before) / 86_400)),
    )
  }
  return out
}

// Must be read before summaryStatements() runs — its UPSERT overwrites the
// value that makes a gap detectable.
export async function priorLastPlay(
  db: D1Database,
  artists: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(artists)].slice(0, MAX_BINDS)
  if (!unique.length) return new Map()
  const placeholders = unique.map((_, i) => `?${i + 1}`).join(', ')
  const rows = await db
    .prepare(`SELECT artist, last_uts FROM artists WHERE artist IN (${placeholders})`)
    .bind(...unique)
    .all<{ artist: string; last_uts: number }>()
  return new Map(rows.results.map((r) => [r.artist, r.last_uts]))
}

// Separates "new to me" from "new to the chart" — an entry absent from last
// period's top 25 may just have ranked lower, not be first-ever. ~25 primary-key
// seeks per list, not a scan.
export async function firstSeenArtists(
  db: D1Database,
  artists: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(artists)].slice(0, MAX_BINDS)
  if (!unique.length) return new Map()
  const rows = await db
    .prepare(
      `SELECT artist, first_uts FROM artists
        WHERE artist IN (${unique.map((_, i) => `?${i + 1}`).join(', ')})`,
    )
    .bind(...unique)
    .all<{ artist: string; first_uts: number }>()
  return new Map(rows.results.map((r) => [r.artist, r.first_uts]))
}

/** Same, for (name, artist) pairs — albums or tracks. Two binds each. */
export async function firstSeenPairs(
  db: D1Database,
  table: 'albums' | 'tracks',
  pairs: { name: string; artist: string }[],
): Promise<Map<string, number>> {
  const column = table === 'albums' ? 'album' : 'track'
  const capped = pairs.slice(0, Math.floor(MAX_BINDS / 2))
  if (!capped.length) return new Map()

  const clause = capped
    .map((_, i) => `(${column} = ?${i * 2 + 1} AND artist = ?${i * 2 + 2})`)
    .join(' OR ')
  const rows = await db
    .prepare(`SELECT ${column} AS name, artist, first_uts FROM ${table} WHERE ${clause}`)
    .bind(...capped.flatMap((p) => [p.name, p.artist]))
    .all<{ name: string; artist: string; first_uts: number }>()
  return new Map(rows.results.map((r) => [`${r.name}${SEP}${r.artist}`, r.first_uts]))
}

/** Returns that landed inside a period, longest silence first. */
export async function returnsIn(
  db: D1Database,
  start: number,
  end: number,
  limit = 10,
): Promise<{ name: string; gapDays: number }[]> {
  const rows = await db
    .prepare(
      `SELECT artist, gap_days FROM returns WHERE uts >= ?1 AND uts < ?2
        ORDER BY gap_days DESC LIMIT ?3`,
    )
    .bind(start, end, limit)
    .all<{ artist: string; gap_days: number }>()
  return rows.results.map((r) => ({ name: r.artist, gapDays: r.gap_days }))
}

// Sums the `days` table (~2,000 rows) instead of COUNT(*) over `scrobbles` (101k).
export async function playsBefore(db: D1Database, day: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(plays), 0) AS n FROM days WHERE day < ?1')
    .bind(day)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** How many artists/albums/tracks were heard for the first time inside a period. */
export async function discoveryIn(
  db: D1Database,
  start: number,
  end: number,
): Promise<DiscoveryCounts> {
  const range = 'first_uts >= ?1 AND first_uts < ?2'
  // Three scalar subqueries in one statement, not three separate ones — keeps
  // the per-invocation query ceiling from capping how many periods a tick can build.
  const [counts, names] = await db.batch<Record<string, number> & { artist: string; first_uts: number }>([
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM artists WHERE ${range}) AS artists,
                (SELECT COUNT(*) FROM albums  WHERE ${range}) AS albums,
                (SELECT COUNT(*) FROM tracks  WHERE ${range}) AS tracks`,
      )
      .bind(start, end),
    db
      .prepare(`SELECT artist, first_uts FROM artists WHERE ${range} ORDER BY first_uts LIMIT 50`)
      .bind(start, end),
  ])

  const row = counts.results[0]
  return {
    artists: Number(row?.artists ?? 0),
    albums: Number(row?.albums ?? 0),
    tracks: Number(row?.tracks ?? 0),
    newArtists: names.results.map((r) => ({ name: r.artist, uts: r.first_uts })),
  }
}

const ROW_COLS = 'uts, track, artist, album, mbid, image'

// Ascending on purpose: session detection, binges and album runs read forward,
// and milestone numbering counts up from `playsBefore`.
export async function fetchPeriodRows(
  db: D1Database,
  start: number,
  end: number,
  limit?: number,
): Promise<Scrobble[]> {
  const rows = await db
    .prepare(
      `SELECT ${ROW_COLS} FROM scrobbles INDEXED BY idx_scrobbles_uts
        WHERE uts >= ?1 AND uts < ?2 ORDER BY uts${limit ? ' LIMIT ?3' : ''}`,
    )
    .bind(...(limit ? [start, end, limit] : [start, end]))
    .all<Scrobble>()
  return rows.results
}

// One range query per window sent as a batch, each seeking its own slice of
// idx_scrobbles_uts — 30 activities over 3 weeks cost ~300 rows, not ~1,500.
// Not UNION ALL: D1's SQLITE_MAX_COMPOUND_SELECT is 5 (vs SQLite's default 500),
// so 6+ windows fail with "too many terms". batch() has no such ceiling — only
// D1's ~50 statements/invocation, which COUNTS_MAX_WINDOWS respects.
export async function countInWindows(
  db: D1Database,
  windows: { from: number; to: number }[],
): Promise<number[]> {
  if (!windows.length) return []

  const results = await db.batch<{ n: number }>(
    windows.map((w) =>
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM scrobbles INDEXED BY idx_scrobbles_uts
            WHERE uts >= ?1 AND uts < ?2`,
        )
        .bind(w.from, w.to),
    ),
  )
  return results.map((r) => r.results[0]?.n ?? 0)
}

/** Daily play counts in a range, for streaks over periods too long to scan raw. */
export async function fetchDays(
  db: D1Database,
  fromDay: string,
  toDay: string,
): Promise<Map<string, number>> {
  const rows = await db
    .prepare('SELECT day, plays FROM days WHERE day >= ?1 AND day < ?2 ORDER BY day')
    .bind(fromDay, toDay)
    .all<{ day: string; plays: number }>()
  return new Map(rows.results.map((r) => [r.day, r.plays]))
}

export interface AllTimeTotals {
  scrobbles: number
  artists: number
  albums: number
  tracks: number
  firstDay: string | null
  lastDay: string | null
}

// Never touches `scrobbles` (101k rows) — summary tables answer the same
// question in ~4,300 + 8,900 + 18,100 rows of COUNT, plays from ~2,000 day rows.
export async function allTimeTotals(db: D1Database): Promise<AllTimeTotals> {
  const [totals, bounds] = await db.batch<Record<string, number | string | null>>([
    db.prepare(
      `SELECT (SELECT COALESCE(SUM(plays), 0) FROM days)  AS scrobbles,
              (SELECT COUNT(*) FROM artists)              AS artists,
              (SELECT COUNT(*) FROM albums)               AS albums,
              (SELECT COUNT(*) FROM tracks)               AS tracks`,
    ),
    db.prepare('SELECT MIN(day) AS firstDay, MAX(day) AS lastDay FROM days'),
  ])
  const t = totals.results[0] ?? {}
  const b = bounds.results[0] ?? {}
  return {
    scrobbles: Number(t.scrobbles ?? 0),
    artists: Number(t.artists ?? 0),
    albums: Number(t.albums ?? 0),
    tracks: Number(t.tracks ?? 0),
    firstDay: (b.firstDay as string) ?? null,
    lastDay: (b.lastDay as string) ?? null,
  }
}

/** All-time leaderboards, straight off the summary tables. */
export async function allTimeTops(db: D1Database, limit: number) {
  const [artists, albums, tracks] = await db.batch<Record<string, string | number>>([
    db.prepare('SELECT artist, plays FROM artists ORDER BY plays DESC, artist LIMIT ?1').bind(limit),
    db.prepare('SELECT album, artist, plays FROM albums ORDER BY plays DESC, album LIMIT ?1').bind(limit),
    db.prepare('SELECT track, artist, plays FROM tracks ORDER BY plays DESC, track LIMIT ?1').bind(limit),
  ])
  return {
    artists: artists.results as unknown as { artist: string; plays: number }[],
    albums: albums.results as unknown as { album: string; artist: string; plays: number }[],
    tracks: tracks.results as unknown as { track: string; artist: string; plays: number }[],
  }
}

/** Guard so a caller can't build a statement past D1's bind-parameter ceiling. */
export const bindLimit = (n: number) => Math.min(n, MAX_BINDS)
