// Layer 2 maintenance: fill artist_meta / album_meta / track_meta a few rows at
// a time from the cron, and publish the lookup blobs period aggregation reads.
// Aggregation never joins against these tables directly — querying per period
// would be ~18k rows every time, so the whole lookup is published to KV daily.

import { fetchAlbumInfo, fetchArtistInfo, fetchArtistTags, type RawTag } from './lastfm'
import { primaryGenre } from './genres'
import { ORIGIN_OVERRIDES, resolveArtist } from './musicbrainz'

const SEP = '\u001f'

/** How many entities to enrich per cron tick. Small: this shares the tick with ingest. */
const PER_TICK = 2

export const META_KEY = {
  genres: 'meta:v1:genres',
  durations: 'meta:v1:durations',
  origins: 'meta:v1:origins',
} as const

/** artist → canonical genre. */
export type GenreMap = Record<string, string>

/** artist → origin, for the geography and era sections. */
export interface Origin {
  /** ISO 3166-1 alpha-2. */
  c: string | null
  /** 'Group' | 'Person' | … */
  k: string | null
  /** Year the act began. */
  y: number | null
}
/** Keys are deliberately one character: this map carries ~4,300 entries. */
export type OriginMap = Record<string, Origin>
/** "track${SEP}artist" → seconds. */
export type DurationMap = Record<string, number>

export const durationKey = (track: string, artist: string) => `${track}${SEP}${artist}`

interface Pending {
  artists: string[]
  albums: { album: string; artist: string }[]
}

// Anti-join against the summary tables, ordered by play count so artists that
// matter to the charts get enriched first — the one-play long tail can wait.
async function pending(db: D1Database, limit: number): Promise<Pending> {
  const [artists, albums] = await db.batch<Record<string, string>>([
    db
      .prepare(
        `SELECT a.artist FROM artists a
           LEFT JOIN artist_meta m ON m.artist = a.artist
          WHERE m.artist IS NULL
          ORDER BY a.plays DESC LIMIT ?1`,
      )
      .bind(limit),
    db
      .prepare(
        `SELECT b.album, b.artist FROM albums b
           LEFT JOIN album_meta m ON m.album = b.album AND m.artist = b.artist
          WHERE m.album IS NULL
          ORDER BY b.plays DESC LIMIT ?1`,
      )
      .bind(limit),
  ])
  return {
    artists: artists.results.map((r) => r.artist),
    albums: albums.results as unknown as { album: string; artist: string }[],
  }
}

/** How much is left to enrich, for logging and the readiness check. */
export async function enrichmentBacklog(db: D1Database): Promise<{ artists: number; albums: number }> {
  const [artists, albums] = await db.batch<{ n: number }>([
    db.prepare(
      `SELECT COUNT(*) AS n FROM artists a
         LEFT JOIN artist_meta m ON m.artist = a.artist WHERE m.artist IS NULL`,
    ),
    db.prepare(
      `SELECT COUNT(*) AS n FROM albums b
         LEFT JOIN album_meta m ON m.album = b.album AND m.artist = b.artist
        WHERE m.album IS NULL`,
    ),
  ])
  return { artists: artists.results[0]?.n ?? 0, albums: albums.results[0]?.n ?? 0 }
}

// Failures are recorded (a `missing = 1` meta row) rather than retried
// immediately, so one permanently unresolvable artist can't block the queue.
export async function enrichSome(env: Env, now: number): Promise<number> {
  const work = await pending(env.DB, PER_TICK)
  const statements: D1PreparedStatement[] = []
  let handled = 0

  for (const artist of work.artists.slice(0, PER_TICK)) {
    try {
      const { tags, found } = await fetchArtistTags(env.LASTFM_API_KEY, artist)
      statements.push(
        env.DB.prepare(
          `INSERT INTO artist_meta (artist, tags, fetched_at, missing)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(artist) DO UPDATE SET
             tags = excluded.tags, fetched_at = excluded.fetched_at, missing = excluded.missing`,
        ).bind(artist, JSON.stringify(tags), now, found ? 0 : 1),
      )
      handled++
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', stage: 'enrich-artist', artist, error: String(err) }))
      statements.push(
        env.DB.prepare(
          `INSERT INTO artist_meta (artist, tags, fetched_at, missing) VALUES (?1, NULL, ?2, 1)
           ON CONFLICT(artist) DO UPDATE SET fetched_at = excluded.fetched_at, missing = 1`,
        ).bind(artist, now),
      )
    }
  }

  for (const { album, artist } of work.albums.slice(0, PER_TICK)) {
    try {
      const info = await fetchAlbumInfo(env.LASTFM_API_KEY, artist, album)
      statements.push(
        env.DB.prepare(
          `INSERT INTO album_meta (album, artist, tags, fetched_at, missing)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(album, artist) DO UPDATE SET
             tags = excluded.tags, fetched_at = excluded.fetched_at, missing = excluded.missing`,
        ).bind(album, artist, JSON.stringify(info.tags), now, info.found ? 0 : 1),
      )
      // One album call yields durations for its whole tracklist — store them all,
      // even for tracks not yet scrobbled, since the row costs nothing.
      for (const track of info.tracks) {
        if (track.duration === null) continue
        statements.push(
          env.DB.prepare(
            `INSERT INTO track_meta (track, artist, duration, fetched_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(track, artist) DO UPDATE SET
               duration = excluded.duration, fetched_at = excluded.fetched_at`,
          ).bind(track.name, artist, track.duration, now),
        )
      }
      handled++
    } catch (err) {
      console.log(
        JSON.stringify({ level: 'warn', stage: 'enrich-album', album, artist, error: String(err) }),
      )
      statements.push(
        env.DB.prepare(
          `INSERT INTO album_meta (album, artist, tags, fetched_at, missing)
           VALUES (?1, ?2, NULL, ?3, 1)
           ON CONFLICT(album, artist) DO UPDATE SET fetched_at = excluded.fetched_at, missing = 1`,
        ).bind(album, artist, now),
      )
    }
  }

  // D1 allows 50 statements per invocation; a 30-track album can approach that.
  for (let i = 0; i < statements.length; i += 40) {
    await env.DB.batch(statements.slice(i, i + 40))
  }
  return handled
}

// Normalization happens here, not at fetch time, so revising the taxonomy in
// genres.ts is a redeploy + blob rebuild rather than 4,340 API calls.
export async function buildGenreMap(env: Env): Promise<GenreMap> {
  const rows = await env.DB.prepare(
    'SELECT artist, tags FROM artist_meta WHERE tags IS NOT NULL',
  ).all<{ artist: string; tags: string }>()

  const map: GenreMap = {}
  for (const row of rows.results) {
    let tags: RawTag[]
    try {
      tags = JSON.parse(row.tags) as RawTag[]
    } catch {
      continue
    }
    const genre = primaryGenre(tags)
    if (genre) map[row.artist] = genre
  }
  return map
}

// One artist per call: MusicBrainz caps 1 req/s and resolveArtist() may make
// two. scripts/musicbrainz-listening.mjs handles the bulk archive; this just
// keeps up with newly-heard artists.
export async function enrichOneOrigin(env: Env, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT a.artist FROM artists a
       LEFT JOIN artist_meta m ON m.artist = a.artist
      WHERE m.mb_fetched_at IS NULL
      ORDER BY a.plays DESC LIMIT 1`,
  ).first<{ artist: string }>()
  if (!row) return false

  const artist = row.artist
  try {
    // Last.fm's artist.getInfo carries the MBID, which turns a fuzzy name search
    // into an exact lookup. It is cheap and rate-limited far more generously.
    let mbid: string | null = null
    try {
      const info = await fetchArtistInfo(env.LASTFM_API_KEY, artist)
      mbid = info.mbid
    } catch {
      /* fall through to the name search */
    }

    const origin = await resolveArtist(artist, mbid)
    await env.DB.prepare(
      `INSERT INTO artist_meta (artist, fetched_at, mbid, country, kind, formed_year,
                                mb_fetched_at, mb_missing)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?2, ?7)
       ON CONFLICT(artist) DO UPDATE SET
         mbid = excluded.mbid, country = excluded.country, kind = excluded.kind,
         formed_year = excluded.formed_year, mb_fetched_at = excluded.mb_fetched_at,
         mb_missing = excluded.mb_missing`,
    )
      .bind(artist, now, origin.mbid, origin.country, origin.kind, origin.formedYear,
        origin.found ? 0 : 1)
      .run()
    return true
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', stage: 'enrich-origin', artist, error: String(err) }))
    // Mark it attempted so one unresolvable artist can't head the queue forever.
    await env.DB.prepare(
      `INSERT INTO artist_meta (artist, fetched_at, mb_fetched_at, mb_missing)
       VALUES (?1, ?2, ?2, 1)
       ON CONFLICT(artist) DO UPDATE SET mb_fetched_at = ?2, mb_missing = 1`,
    )
      .bind(artist, now)
      .run()
    return true
  }
}

export async function buildOriginMap(env: Env): Promise<OriginMap> {
  const rows = await env.DB.prepare(
    `SELECT artist, country, kind, formed_year FROM artist_meta
      WHERE country IS NOT NULL OR kind IS NOT NULL OR formed_year IS NOT NULL`,
  ).all<{ artist: string; country: string | null; kind: string | null; formed_year: number | null }>()

  const map: OriginMap = {}
  for (const r of rows.results) {
    map[r.artist] = { c: r.country, k: r.kind, y: r.formed_year }
  }
  // Manual corrections win, and apply even to artists MusicBrainz had nothing
  // for — see ORIGIN_OVERRIDES for why this can't be automated.
  for (const [artist, o] of Object.entries(ORIGIN_OVERRIDES)) {
    map[artist] = { c: o.country, k: o.kind, y: o.formedYear }
  }
  return map
}

export async function buildDurationMap(env: Env): Promise<DurationMap> {
  // Joined against `tracks` so the map holds only what's actually been played —
  // album.getInfo returns a record's whole tracklist, which put 50k entries in a
  // blob that 18k would cover, and blob size is CPU for the period builder.
  const rows = await env.DB.prepare(
    `SELECT m.track, m.artist, m.duration FROM track_meta m
       JOIN tracks t ON t.track = m.track AND t.artist = m.artist
      WHERE m.duration IS NOT NULL`,
  ).all<{ track: string; artist: string; duration: number }>()

  const map: DurationMap = {}
  for (const row of rows.results) map[durationKey(row.track, row.artist)] = row.duration
  return map
}

// The "has the source data changed" signal for the lookup blobs. A pure timer
// isn't enough: scripts/enrich-listening.mjs can bulk-write rows without going
// through enrichSome(), which would otherwise leave a blob pinned to a
// near-empty snapshot until the timer expired. track_meta needs no check of its
// own — its rows are always written alongside the album row that produced them.
export async function metaWatermark(db: D1Database): Promise<number> {
  const [artists, albums, mb] = await db.batch<{ v: number | null }>([
    db.prepare('SELECT MAX(fetched_at) AS v FROM artist_meta'),
    db.prepare('SELECT MAX(fetched_at) AS v FROM album_meta'),
    db.prepare('SELECT MAX(mb_fetched_at) AS v FROM artist_meta'),
  ])
  return Math.max(artists.results[0]?.v ?? 0, albums.results[0]?.v ?? 0, mb.results[0]?.v ?? 0)
}

export interface MetaLookups {
  genres: GenreMap
  durations: DurationMap
  origins: OriginMap
}

// Parsed lookups (~1MB of JSON), cached for the isolate's life. Re-parsing per
// period was spending the whole 10ms CPU budget on identical bytes, enough to
// fail invocations with exceededCpu and silently stall the backfill. Best-effort
// since isolates recycle freely; the TTL keeps a long-lived one from going stale.
let lookupCache: { at: number; value: MetaLookups } | null = null
const LOOKUP_CACHE_MS = 10 * 60 * 1000

/** Read all three lookups. Missing blobs degrade to empty, not to an error. */
export async function readLookups(env: Env): Promise<MetaLookups> {
  const fresh = lookupCache && Date.now() - lookupCache.at < LOOKUP_CACHE_MS
  if (lookupCache && fresh) return lookupCache.value

  const [genres, durations, origins] = await Promise.all([
    env.KV.get<GenreMap>(META_KEY.genres, 'json'),
    env.KV.get<DurationMap>(META_KEY.durations, 'json'),
    env.KV.get<OriginMap>(META_KEY.origins, 'json'),
  ])
  const value = { genres: genres ?? {}, durations: durations ?? {}, origins: origins ?? {} }
  lookupCache = { at: Date.now(), value }
  return value
}

// Two KV writes, so this runs daily rather than per tick. The duration map is
// the big one (~18k entries, a few hundred KB) — well inside KV's 25MB ceiling,
// and far cheaper than the ~18k D1 row reads an equivalent join would cost.
export async function refreshLookups(
  env: Env,
): Promise<{ genres: number; durations: number; origins: number }> {
  const [genres, durations, origins] = await Promise.all([
    buildGenreMap(env),
    buildDurationMap(env),
    buildOriginMap(env),
  ])
  await Promise.all([
    env.KV.put(META_KEY.genres, JSON.stringify(genres)),
    env.KV.put(META_KEY.durations, JSON.stringify(durations)),
    env.KV.put(META_KEY.origins, JSON.stringify(origins)),
  ])
  return {
    genres: Object.keys(genres).length,
    durations: Object.keys(durations).length,
    origins: Object.keys(origins).length,
  }
}
