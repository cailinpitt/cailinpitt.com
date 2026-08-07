// Layer 2 maintenance: fill artist_meta / album_meta / track_meta a few rows at
// a time from the cron, and publish the two lookup blobs that period aggregation
// reads.
//
// Aggregation must never join against these tables. A period compute already
// holds its rows in memory and would need a duration for each of them; querying
// per period would be ~18k rows every time. Instead the whole lookup is
// published to KV once a day and read as a single value.

import { fetchAlbumInfo, fetchArtistTags, type RawTag } from './lastfm'
import { primaryGenre } from './genres'

const SEP = '\u001f'

/** How many entities to enrich per cron tick. Small: this shares the tick with ingest. */
const PER_TICK = 2

export const META_KEY = {
  genres: 'meta:v1:genres',
  durations: 'meta:v1:durations',
} as const

/** artist → canonical genre. */
export type GenreMap = Record<string, string>
/** "track${SEP}artist" → seconds. */
export type DurationMap = Record<string, number>

export const durationKey = (track: string, artist: string) => `${track}${SEP}${artist}`

// ---- enrichment queue ----------------------------------------------------

interface Pending {
  artists: string[]
  albums: { album: string; artist: string }[]
}

/**
 * What still needs looking up.
 *
 * An anti-join against the summary tables, ordered by play count so the artists
 * that actually matter to the charts are enriched first — the long tail of
 * one-play artists can wait, and if a lookup never succeeds for them it barely
 * moves a share.
 */
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

/**
 * Enrich a couple of entities. Returns how many were handled.
 *
 * Failures are recorded rather than retried immediately: a row that errors gets
 * a meta row with `missing = 1`, which takes it out of the queue. Otherwise one
 * permanently unresolvable artist would sit at the head of the queue forever and
 * block everything behind it.
 */
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

// ---- lookup blobs --------------------------------------------------------

/**
 * Rebuild the artist → genre map.
 *
 * Normalization happens here, not at fetch time, so revising the taxonomy in
 * genres.ts is a redeploy plus a blob rebuild rather than 4,340 API calls.
 */
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

/** Rebuild the (track, artist) → seconds map. */
export async function buildDurationMap(env: Env): Promise<DurationMap> {
  const rows = await env.DB.prepare(
    'SELECT track, artist, duration FROM track_meta WHERE duration IS NOT NULL',
  ).all<{ track: string; artist: string; duration: number }>()

  const map: DurationMap = {}
  for (const row of rows.results) map[durationKey(row.track, row.artist)] = row.duration
  return map
}

export interface MetaLookups {
  genres: GenreMap
  durations: DurationMap
}

/** Read both lookups. Missing blobs degrade to empty, not to an error. */
export async function readLookups(env: Env): Promise<MetaLookups> {
  const [genres, durations] = await Promise.all([
    env.KV.get<GenreMap>(META_KEY.genres, 'json'),
    env.KV.get<DurationMap>(META_KEY.durations, 'json'),
  ])
  return { genres: genres ?? {}, durations: durations ?? {} }
}

/**
 * Republish both lookups. Two KV writes, so this runs daily rather than per tick.
 *
 * The duration map is the big one — ~18k entries, a few hundred KB. That is well
 * inside KV's 25 MB value ceiling, and reading it once per period compute is far
 * cheaper than the ~18k D1 row reads the equivalent join would cost.
 */
export async function refreshLookups(env: Env): Promise<{ genres: number; durations: number }> {
  const [genres, durations] = await Promise.all([buildGenreMap(env), buildDurationMap(env)])
  await Promise.all([
    env.KV.put(META_KEY.genres, JSON.stringify(genres)),
    env.KV.put(META_KEY.durations, JSON.stringify(durations)),
  ])
  return { genres: Object.keys(genres).length, durations: Object.keys(durations).length }
}
