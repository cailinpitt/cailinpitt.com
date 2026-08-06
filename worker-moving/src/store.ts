// D1 reads for the /activity API. Same shape as worker-watching's store:
// straight from D1 behind the edge cache, no precomputed blobs.

/** Kinds a caller may filter on; mirrors ActivityKind in strava.ts. */
const KINDS = new Set(['ride', 'ebike', 'lift', 'walk', 'run', 'yoga', 'climb', 'other'])

export const ACTIVITY_PAGE = 30
const MAX_ACTIVITY_PAGE = 100

// name and commute are stored but deliberately not served: the log renders a
// summary built from the numbers, and neither field reaches the page.
const COLS = 'id, sport_type, kind, start_date, distance_mi, elevation_ft, moving_time, trainer'

export interface Activity {
  id: string
  sportType: string
  kind: string
  /** YYYY-MM-DD, athlete-local. */
  startDate: string
  distanceMi: number
  elevationFt: number
  movingTime: number
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
  distance_mi: number
  elevation_ft: number
  moving_time: number
  trainer: number
}

const toActivity = (r: Row): Activity => ({
  id: r.id,
  sportType: r.sport_type,
  kind: (r.kind as Activity['kind']) ?? 'other',
  startDate: r.start_date,
  distanceMi: r.distance_mi,
  elevationFt: r.elevation_ft,
  movingTime: r.moving_time,
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
