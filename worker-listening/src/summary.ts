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

export interface DiscoveryCounts {
  artists: number
  albums: number
  tracks: number
  newArtists: { name: string; uts: number }[]
}

/**
 * Statements maintaining the summary tables for rows that were *actually*
 * inserted.
 *
 * Correctness note: ingest re-offers an hour of overlap on every pull and leans
 * on INSERT OR IGNORE to drop what it already has. Those ignored rows must not
 * reach these counters, or `plays` drifts upward a little every minute forever.
 * The caller therefore feeds this the RETURNING output of the archive insert,
 * never the raw Last.fm page.
 */
export function summaryStatements(env: Env, inserted: Scrobble[]): D1PreparedStatement[] {
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
  return out
}

/**
 * Scrobbles strictly before a period, for milestone numbering.
 *
 * Summing the `days` table costs ~2,000 rows; COUNT(*) over `scrobbles` would
 * cost 101k for the same answer.
 */
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
  const [artists, albums, tracks, names] = await db.batch<{ n: number } & { artist: string; first_uts: number }>([
    db.prepare(`SELECT COUNT(*) AS n FROM artists WHERE ${range}`).bind(start, end),
    db.prepare(`SELECT COUNT(*) AS n FROM albums  WHERE ${range}`).bind(start, end),
    db.prepare(`SELECT COUNT(*) AS n FROM tracks  WHERE ${range}`).bind(start, end),
    db
      .prepare(`SELECT artist, first_uts FROM artists WHERE ${range} ORDER BY first_uts LIMIT 50`)
      .bind(start, end),
  ])

  return {
    artists: artists.results[0]?.n ?? 0,
    albums: albums.results[0]?.n ?? 0,
    tracks: tracks.results[0]?.n ?? 0,
    newArtists: names.results.map((r) => ({ name: r.artist, uts: r.first_uts })),
  }
}

const ROW_COLS = 'uts, track, artist, album, mbid, image'

/**
 * The raw rows for a period, oldest first.
 *
 * Ascending on purpose: session detection, binges and album runs all read the
 * timeline forwards, and milestone numbering counts up from `playsBefore`.
 */
export async function fetchPeriodRows(
  db: D1Database,
  start: number,
  end: number,
): Promise<Scrobble[]> {
  const rows = await db
    .prepare(
      `SELECT ${ROW_COLS} FROM scrobbles INDEXED BY idx_scrobbles_uts
        WHERE uts >= ?1 AND uts < ?2 ORDER BY uts`,
    )
    .bind(start, end)
    .all<Scrobble>()
  return rows.results
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

/**
 * All-time totals without touching `scrobbles` at all.
 *
 * The archive is 101k rows and growing; the summary tables answer the same
 * question in ~4,300 + 8,900 + 18,100 rows of COUNT, and the play total comes
 * from summing ~2,000 day rows.
 */
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
