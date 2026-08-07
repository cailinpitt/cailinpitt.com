// D1 reads for the /activity API. Same shape as worker-watching's store:
// straight from D1 behind the edge cache, no precomputed blobs.

/** Kinds a caller may filter on; mirrors ActivityKind in strava.ts. */
const KINDS = new Set(['ride', 'ebike', 'lift', 'walk', 'run', 'yoga', 'climb', 'other'])

export const ACTIVITY_PAGE = 30
const MAX_ACTIVITY_PAGE = 100

// name and commute are stored but deliberately not served: the log renders a
// summary built from the numbers, and neither field reaches the page.
// `started_at` and `elapsed_time` are what make an activity a *window* in time
// rather than a date, which is what the listening crossover needs to ask "what
// was playing during this ride". Both were already stored and synced; they just
// weren't served.
const COLS =
  'id, sport_type, kind, start_date, started_at, distance_mi, elevation_ft, moving_time, ' +
  'elapsed_time, trainer, MIN(elapsed_time, MAX(moving_time, 0) + 1800) AS window_seconds'

export interface Activity {
  id: string
  sportType: string
  kind: string
  /** YYYY-MM-DD, athlete-local. */
  startDate: string
  /** Unix seconds, UTC. The start of the activity's window. */
  startedAt: number
  distanceMi: number
  elevationFt: number
  movingTime: number
  /** Seconds including pauses — the raw recorded span. */
  elapsedTime: number
  /**
   * The activity's usable window, in seconds — what "during this activity"
   * means. Moving time plus a pause allowance, capped at what was recorded; see
   * the note on ActivityWindow for why raw elapsed time is the wrong answer.
   * Served here too so callers don't have to re-derive the rule.
   */
  windowSeconds: number
  trainer: boolean
}

export interface ActivityPage {
  activities: Activity[]
  /** Opaque; pass straight back to /activities. Null means the history is done. */
  nextCursor: string | null
}

export interface MovingBundle {
  updatedAt: number
  activities: Activity[]
  nextCursor: string | null
  counts: {
    activities: number
    rides: number
    lifts: number
    distanceMi: number
    movingTime: number
    activitiesThisYear: number
    ridesThisYear: number
    liftsThisYear: number
    distanceMiThisYear: number
  }
}

interface Row {
  id: string
  sport_type: string
  kind: string
  start_date: string
  started_at: number
  distance_mi: number
  elevation_ft: number
  moving_time: number
  elapsed_time: number
  window_seconds: number
  trainer: number
}

const toActivity = (r: Row): Activity => ({
  id: r.id,
  sportType: r.sport_type,
  kind: (r.kind as Activity['kind']) ?? 'other',
  startDate: r.start_date,
  startedAt: r.started_at,
  distanceMi: r.distance_mi,
  elevationFt: r.elevation_ft,
  movingTime: r.moving_time,
  elapsedTime: r.elapsed_time,
  windowSeconds: r.window_seconds,
  trainer: r.trainer === 1,
})

// Composite cursor — `<start_date>:<id>` — because start_date is not unique:
// two rides in one day are ordinary, and a bare date cursor would drop one at
// each page boundary.
const encodeCursor = (a: Activity): string => `${a.startDate}:${a.id}`

function decodeCursor(raw: string | null): [string, string] | null {
  if (!raw) return null
  const at = raw.indexOf(':')
  if (at < 1) return null
  const date = raw.slice(0, at)
  const id = raw.slice(at + 1)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d+$/.test(id) ? [date, id] : null
}

export async function fetchActivities(
  db: D1Database,
  cursor: string | null,
  limit: number,
  kind?: string | null,
): Promise<ActivityPage> {
  const size = Math.min(Math.max(limit, 1), MAX_ACTIVITY_PAGE)
  const from = decodeCursor(cursor)
  const filtered = kind != null && KINDS.has(kind)

  const where: string[] = []
  const binds: unknown[] = []
  if (from) {
    where.push('(start_date, id) < (?, ?)')
    binds.push(from[0], from[1])
  }
  if (filtered) {
    where.push('kind = ?')
    binds.push(kind)
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  // One extra row to learn whether another page exists without a COUNT.
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM activities ${clause} ORDER BY start_date DESC, id DESC LIMIT ?`)
    .bind(...binds, size + 1)
    .all<Row>()

  const rows = (results ?? []).map(toActivity)
  const hasMore = rows.length > size
  const activities = hasMore ? rows.slice(0, size) : rows
  return {
    activities,
    nextCursor: hasMore && activities.length ? encodeCursor(activities[activities.length - 1]) : null,
  }
}

// ---- the homepage strip / terminal ----------------------------------------

export interface ActivityNow {
  lastActivity: Activity | null
  updatedAt: number
}

/** One row, for whatever renders a single line. */
export async function buildNow(db: D1Database): Promise<ActivityNow> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM activities ORDER BY start_date DESC, id DESC LIMIT 1`)
    .first<Row>()

  return {
    lastActivity: row ? toActivity(row) : null,
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

// ---- the bundle -----------------------------------------------------------

interface YearTotals {
  activities: number
  rides: number
  lifts: number
  distanceMi: number
}

const EMPTY_YEAR: YearTotals = { activities: 0, rides: 0, lifts: 0, distanceMi: 0 }

function yearFrom(byYear: string | undefined, year: number): YearTotals {
  if (!byYear) return EMPTY_YEAR
  try {
    const parsed = JSON.parse(byYear) as Record<string, Partial<YearTotals>>
    const found = parsed[String(year)]
    return found ? { ...EMPTY_YEAR, ...found } : EMPTY_YEAR
  } catch {
    return EMPTY_YEAR
  }
}

export async function buildBundle(db: D1Database, year: number): Promise<MovingBundle> {
  const [page, counts] = await Promise.all([
    fetchActivities(db, null, ACTIVITY_PAGE),
    db
      .prepare(
        'SELECT activities, rides, lifts, distance_mi, moving_time, by_year FROM stats WHERE id = 1',
      )
      .first<{
        activities: number
        rides: number
        lifts: number
        distance_mi: number
        moving_time: number
        by_year: string
      }>(),
  ])

  const thisYear = yearFrom(counts?.by_year, year)

  return {
    updatedAt: Math.floor(Date.now() / 1000),
    activities: page.activities,
    nextCursor: page.nextCursor,
    counts: {
      activities: counts?.activities ?? 0,
      rides: counts?.rides ?? 0,
      lifts: counts?.lifts ?? 0,
      distanceMi: counts?.distance_mi ?? 0,
      movingTime: counts?.moving_time ?? 0,
      activitiesThisYear: thisYear.activities,
      ridesThisYear: thisYear.rides,
      liftsThisYear: thisYear.lifts,
      distanceMiThisYear: thisYear.distanceMi,
    },
  }
}

export interface ActivityWindow {
  id: string
  kind: string
  /** Unix seconds, UTC. */
  startedAt: number
  /**
   * The window's usable length in seconds — what "during this activity" means.
   *
   * Not raw `elapsed_time`. Recordings routinely get left running long after the
   * activity ends: across 2021 the elapsed total is 1,081 hours against 304 of
   * actual moving, and 84 activities exceed four hours. Anything consuming this
   * as a time window would sweep up a whole evening after a 40-minute ride.
   *
   * Not raw `moving_time` either — that excludes genuine pauses at lights and
   * rest stops, which are still part of the activity.
   *
   * So: moving time plus a pause allowance, never exceeding what was actually
   * recorded.
   */
  seconds: number
  /** The raw recorded span, for callers that want to see the difference. */
  elapsedTime: number
}

/** How much stopped time still counts as being on the activity. Mirrored
 * literally in COLS above, which cannot interpolate. */
const PAUSE_GRACE = 30 * 60

/**
 * Activities overlapping a time range, as bare windows.
 *
 * Exists for the listening crossover, which needs to ask "was I moving when this
 * scrobble happened" for a whole period at once. Serving that off /activities
 * would mean paginating the full records; this is four columns and one index
 * range, so a year costs a few hundred small rows.
 *
 * The range test is overlap, not containment: an activity that started before
 * `from` can still be running inside it. But `started_at + elapsed_time` is not
 * indexable, so the lower bound is expressed on `started_at` alone — nothing can
 * have started more than MAX_ACTIVITY_SECONDS before `from` and still overlap.
 * That keeps this an index range instead of a full scan as the table grows.
 */
/** Generous ceiling on activity length; the longest on record is ~15.5 hours. */
const MAX_ACTIVITY_SECONDS = 24 * 60 * 60

export async function fetchWindows(
  db: D1Database,
  from: number,
  to: number,
): Promise<ActivityWindow[]> {
  const rows = await db
    .prepare(
      `SELECT id, kind, started_at, elapsed_time,
              MIN(elapsed_time, MAX(moving_time, 0) + ?4) AS window_seconds
         FROM activities
        WHERE started_at >= ?1 AND started_at < ?2
          AND started_at + MIN(elapsed_time, MAX(moving_time, 0) + ?4) > ?3
        ORDER BY started_at`,
    )
    .bind(from - MAX_ACTIVITY_SECONDS, to, from, PAUSE_GRACE)
    .all<{
      id: string
      kind: string
      started_at: number
      elapsed_time: number
      window_seconds: number
    }>()

  return rows.results.map((r) => ({
    id: r.id,
    kind: r.kind,
    startedAt: r.started_at,
    seconds: r.window_seconds,
    elapsedTime: r.elapsed_time,
  }))
}
