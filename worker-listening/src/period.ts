// Period blob orchestration: build one PeriodStats, and track which ones exist.
//
// Nothing here runs on a request. The fetch handler only ever reads a finished
// blob out of KV — see the note at the top of index.ts.

import { aggregate, type PeriodStats } from './aggregate'
import {
  dayKey,
  enumeratePeriods,
  parsePeriod,
  periodContaining,
  previousPeriod,
  type Period,
  type PeriodKind,
} from './periods'
import {
  allTimeTops,
  allTimeTotals,
  discoveryIn,
  fetchPeriodRows,
  playsBefore,
} from './summary'
import { readLookups } from './enrich'

/**
 * Blob namespace. **Bump this whenever a stored period's shape or meaning
 * changes** — a new stat, or an edit to the genre taxonomy in genres.ts.
 *
 * Completed periods are frozen forever, so there is no other way to make them
 * pick up a change. Bumping orphans the old keys (they cost storage only, and
 * KV storage is not a metered constraint here) and the backfill walk rebuilds
 * every period under the new prefix within a day.
 *
 * v2: genres (Tier B) and listening time (Tier C).
 * v3: rebuild after the genre/duration backfill landed — v2 blobs were computed
 *     against near-empty lookups and would otherwise stay that way forever.
 */
export const PREFIX = 'p:v3:'

export const blobKey = (kind: PeriodKind, key: string) => `${PREFIX}${kind}:${key}`

/** Which period blobs exist, by kind. */
export interface PeriodIndex {
  w: string[]
  m: string[]
  y: string[]
  all: boolean
}

const TOP_N = 25

/**
 * Enumerate existing blobs by listing KV rather than maintaining an index key.
 *
 * An index key would have to be rewritten every time a period is frozen — ~356
 * extra writes during the initial backfill, against a 1,000 writes/day ceiling
 * that `now:v1` already spends a third of. Listing costs a read instead, and the
 * whole archive is ~356 keys, comfortably inside one 1,000-key list page.
 */
export async function listPeriods(env: Env): Promise<PeriodIndex> {
  const out: PeriodIndex = { w: [], m: [], y: [], all: false }
  let cursor: string | undefined
  do {
    const page = await env.KV.list({ prefix: PREFIX, cursor })
    for (const { name } of page.keys) {
      const rest = name.slice(PREFIX.length)
      const split = rest.indexOf(':')
      if (split < 0) {
        if (rest === 'all') out.all = true
        continue
      }
      const kind = rest.slice(0, split)
      const key = rest.slice(split + 1)
      if (kind === 'w' || kind === 'm' || kind === 'y') out[kind].push(key)
      else if (kind === 'all') out.all = true
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)

  out.w.sort()
  out.m.sort()
  out.y.sort()
  return out
}

/**
 * Build one period's stats.
 *
 * Reads the previous period's blob when it exists so deltas and rank movement
 * come for free — one KV read against re-aggregating a second period.
 */
export async function computePeriod(
  env: Env,
  period: Period,
  now: number,
): Promise<PeriodStats> {
  const offset = Number(env.TZ_OFFSET_SECONDS) || 0

  if (period.kind === 'all') return computeAllTime(env, now)

  const prev = previousPeriod(period, offset)
  const [rows, discovery, before, previous, lookups] = await Promise.all([
    fetchPeriodRows(env.DB, period.start, period.end),
    discoveryIn(env.DB, period.start, period.end),
    playsBefore(env.DB, dayKey(period.start, offset)),
    prev
      ? env.KV.get<PeriodStats>(blobKey(prev.kind, prev.key), 'json')
      : Promise.resolve(null),
    readLookups(env),
  ])

  const stats = aggregate({
    rows,
    period,
    offset,
    now,
    playsBefore: before,
    previous,
    genreOf: lookups.genres,
    durationOf: lookups.durations,
  })

  stats.discovery = {
    ...discovery,
    // Share of the period's distinct tracks that were first-ever plays.
    rate: stats.tracks ? Math.round((discovery.tracks / stats.tracks) * 1000) / 10 : 0,
  }
  return stats
}

/**
 * All-time, assembled without reading a single raw scrobble.
 *
 * Totals and leaderboards come off the summary tables; the shape-of-the-listening
 * fields are folded out of the year blobs, which are already computed. A streak
 * that crosses New Year is therefore counted as two — the price of never scanning
 * 101k rows, and invisible at this granularity.
 */
async function computeAllTime(env: Env, now: number): Promise<PeriodStats> {
  const offset = Number(env.TZ_OFFSET_SECONDS) || 0
  const [totals, tops] = await Promise.all([
    allTimeTotals(env.DB),
    allTimeTops(env.DB, TOP_N),
  ])

  const start = totals.firstDay
    ? Math.floor(new Date(`${totals.firstDay}T00:00:00Z`).getTime() / 1000) - offset
    : now

  const years = totals.firstDay
    ? enumeratePeriods('y', start, now, offset)
    : []
  const blobs = (
    await Promise.all(
      years.map((y) => env.KV.get<PeriodStats>(blobKey('y', y.key), 'json')),
    )
  ).filter((b): b is PeriodStats => Boolean(b))

  const clock = new Array(24).fill(0) as number[]
  const weekdays = new Array(7).fill(0) as number[]
  const grid = new Array(168).fill(0) as number[]
  let activeDays = 0
  let sessions = 0
  let longestStreak = 0
  let longestSilence = 0
  let longestSession: PeriodStats['sessions']['longest'] = null
  let busiestDay: PeriodStats['busiestDay'] = null
  const binges: PeriodStats['binges'] = []
  const albumListens: PeriodStats['albumListens'] = []
  const milestones: PeriodStats['milestones'] = []
  // Genres and time fold out of the year blobs the same way the clock does.
  const genreCounts = new Map<string, number>()
  let genrePlays = 0
  let totalSeconds = 0
  let coverageWeighted = 0
  let longestTrack: PeriodStats['listening']['longest'] = null
  const secondsByArtist = new Map<string, number>()

  for (const b of blobs) {
    for (const g of b.genres ?? []) {
      // The blob stores shares of classified plays; recover the play count so
      // years with different coverage combine honestly.
      const count = g.count ?? 0
      genreCounts.set(g.name, (genreCounts.get(g.name) ?? 0) + count)
      genrePlays += count
    }
    if (b.listening) {
      totalSeconds += b.listening.seconds
      coverageWeighted += (b.listening.coverage / 100) * b.scrobbles
      if (b.listening.longest && (!longestTrack || b.listening.longest.seconds > longestTrack.seconds)) {
        longestTrack = b.listening.longest
      }
      for (const a of b.listening.topByTime ?? []) {
        secondsByArtist.set(a.name, (secondsByArtist.get(a.name) ?? 0) + a.seconds)
      }
    }
  }

  for (const b of blobs) {
    for (let i = 0; i < 24; i++) clock[i] += b.clock[i] ?? 0
    for (let i = 0; i < 7; i++) weekdays[i] += b.weekdays[i] ?? 0
    for (let i = 0; i < 168; i++) grid[i] += b.grid[i] ?? 0
    activeDays += b.activeDays
    sessions += b.sessions.count
    longestStreak = Math.max(longestStreak, b.streaks.longest)
    longestSilence = Math.max(longestSilence, b.streaks.longestSilence)
    if (b.sessions.longest && (!longestSession || b.sessions.longest.tracks > longestSession.tracks)) {
      longestSession = b.sessions.longest
    }
    if (b.busiestDay && (!busiestDay || b.busiestDay.count > busiestDay.count)) busiestDay = b.busiestDay
    binges.push(...b.binges)
    albumListens.push(...b.albumListens)
    milestones.push(...b.milestones)
  }

  const scrobbles = totals.scrobbles
  const elapsedDays = Math.max(1, Math.round((now - start) / 86_400))
  const peakHour = scrobbles ? clock.indexOf(Math.max(...clock)) : null
  const weekendPlays = weekdays[5] + weekdays[6]
  const lateNight = clock[0] + clock[1] + clock[2] + clock[3] + clock[4]

  const share = (n: number) => (scrobbles ? Math.round((n / scrobbles) * 1000) / 10 : 0)
  const rankOf = <T>(list: T[], count: (t: T) => number) =>
    list.map((row) => ({ ...row, share: share(count(row)), prevRank: null }))

  return {
    kind: 'all',
    key: 'all',
    label: 'All time',
    start,
    end: now,
    complete: false,
    computedAt: now,

    scrobbles,
    artists: totals.artists,
    albums: totals.albums,
    tracks: totals.tracks,
    perDay: Math.round((scrobbles / elapsedDays) * 10) / 10,
    activeDays,
    silentDays: Math.max(0, elapsedDays - activeDays),

    top: {
      artists: rankOf(
        tops.artists.map((a) => ({ name: a.artist, count: a.plays, image: null })),
        (a) => a.count,
      ),
      albums: rankOf(
        tops.albums.map((a) => ({ album: a.album, artist: a.artist, count: a.plays, image: null })),
        (a) => a.count,
      ),
      tracks: rankOf(
        tops.tracks.map((t) => ({ track: t.track, artist: t.artist, count: t.plays, image: null })),
        (t) => t.count,
      ),
    },

    clock,
    weekdays,
    grid,
    peakHour,
    quietestHour: scrobbles ? clock.indexOf(Math.min(...clock)) : null,
    peakWeekday: scrobbles ? weekdays.indexOf(Math.max(...weekdays)) : null,
    weekendShare: share(weekendPlays),
    lateNightShare: share(lateNight),

    series: blobs.map((b) => ({ key: b.key, label: b.key, count: b.scrobbles })),
    busiestDay,
    busiestHour: peakHour === null ? null : { hour: peakHour, count: clock[peakHour] },

    streaks: { longest: longestStreak, longestSilence },
    sessions: {
      count: sessions,
      avgTracks: sessions ? Math.round((scrobbles / sessions) * 10) / 10 : 0,
      longest: longestSession,
    },
    binges: binges.sort((a, b) => b.tracks - a.tracks).slice(0, 5),
    albumListens: albumListens.sort((a, b) => b.distinct - a.distinct).slice(0, 5),

    loyalty: {
      repeatRate: totals.tracks ? Math.round((scrobbles / totals.tracks) * 100) / 100 : 0,
      top10Share: share(tops.artists.slice(0, 10).reduce((sum, a) => sum + a.plays, 0)),
      // Needs every artist's share, which the summary tables don't stream cheaply;
      // the per-year blobs each carry their own, so this stays a per-period stat.
      effectiveArtists: 0,
      obsession: null,
    },

    curios: { remix: 0, live: 0, acoustic: 0, collab: 0, longestTitle: null },

    genres: [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([name, count]) => ({
        name,
        count,
        share: genrePlays ? Math.round((count / genrePlays) * 1000) / 10 : 0,
      })),
    // "New" has no meaning across all of time, and a per-year stack would just be
    // the year blobs again.
    newGenres: [],
    genreDiversity: 0,
    genreSeries: [],
    genreCoverage: scrobbles ? Math.round((genrePlays / scrobbles) * 1000) / 10 : 0,

    listening: {
      seconds: totalSeconds,
      coverage: scrobbles ? Math.round((coverageWeighted / scrobbles) * 1000) / 10 : 0,
      avgTrackSeconds: scrobbles ? Math.round(totalSeconds / scrobbles) : 0,
      topByTime: [...secondsByArtist.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([name, seconds]) => ({ name, seconds })),
      longest: longestTrack,
    },

    milestones: milestones.sort((a, b) => a.n - b.n),
    first: null,
    last: null,
    discovery: {
      artists: totals.artists,
      albums: totals.albums,
      tracks: totals.tracks,
      rate: 100,
      newArtists: [],
    },
    abandoned: [],
    delta: { scrobbles: null, artists: null, tracks: null, perDay: null },
  }
}

// ---- work queue ----------------------------------------------------------

/** How stale a live period may get before it is recomputed. */
const LIVE_INTERVAL: Record<PeriodKind, number> = {
  w: 30 * 60,
  m: 2 * 60 * 60,
  y: 6 * 60 * 60,
  all: 24 * 60 * 60,
}

export interface WorkUnit {
  period: Period
  /** True when this fills a gap rather than refreshing a live period. */
  backfill: boolean
}

/**
 * Backfill only runs on ticks whose minute is a multiple of this.
 *
 * The budget maths: `now:v1` spends ~300 KV writes/day and the four live periods
 * ~65, leaving roughly 500 of the 1,000/day ceiling. Unthrottled, an idle tick
 * would backfill every minute and spend 1,440. Every third minute caps it at
 * ~480/day and still clears all ~356 historical periods inside a day.
 */
const BACKFILL_EVERY_MINUTES = 3

/**
 * Pick at most one period to (re)compute this tick.
 *
 * Deliberately one: a year is ~18,700 rows to read and aggregate, and doing
 * several in one invocation is how you blow both the CPU ceiling and the 1,000
 * KV writes/day budget. At 1,440 ticks a day there is no hurry.
 *
 * Live periods come first so the site stays current, and only then does the
 * backfill walk fill in history.
 */
export async function pickWork(
  env: Env,
  index: PeriodIndex,
  firstDay: string | null,
  now: number,
): Promise<WorkUnit | null> {
  const offset = Number(env.TZ_OFFSET_SECONDS) || 0

  // Live periods first, so the site stays current even mid-backfill. `all` is
  // last because it is folded out of the year blobs and wants them fresh.
  for (const kind of ['w', 'm', 'y', 'all'] as PeriodKind[]) {
    const period =
      kind === 'all' ? parsePeriod('all', 'all', offset)! : periodContaining(kind, now, offset)
    const blob = await env.KV.get<PeriodStats>(blobKey(kind, period.key), 'json')
    if (!blob || now - blob.computedAt >= LIVE_INTERVAL[kind]) {
      return { period, backfill: false }
    }
  }

  if (!firstDay) return null
  if (new Date(now * 1000).getUTCMinutes() % BACKFILL_EVERY_MINUTES !== 0) return null

  const start = Math.floor(new Date(`${firstDay}T00:00:00Z`).getTime() / 1000) - offset

  // Years before months before weeks: the coarse pages are the ones people land
  // on first, so they should stop being empty soonest.
  for (const kind of ['y', 'm', 'w'] as Exclude<PeriodKind, 'all'>[]) {
    const have = new Set(index[kind])
    for (const period of enumeratePeriods(kind, start, now, offset)) {
      // Only completed periods are frozen; the live one is handled above.
      if (period.end > now || have.has(period.key)) continue
      return { period, backfill: true }
    }
  }
  return null
}
