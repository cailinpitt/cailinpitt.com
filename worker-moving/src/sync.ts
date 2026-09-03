// The daily pull: Strava → activities.
//
// Two modes. Incremental (the cron) asks only for activities newer than the
// archive, minus an overlap window so edits land. Backfill walks backwards from
// the oldest row we hold, a few pages per pass, until it runs out of history.

import { PER_PAGE, accessToken, fetchActivities, type SummaryActivity } from './strava'

/**
 * How far back an incremental run re-reads. Renames, a corrected sport type,
 * and manual entries logged late all show up inside a week.
 */
const OVERLAP_SECONDS = 7 * 24 * 60 * 60

/** Pages per run, so one invocation can't blow the subrequest ceiling. */
function pageBudget(env: Env): number {
  const configured = Number(env.PAGE_BUDGET)
  return Number.isFinite(configured) && configured > 0 ? configured : 8
}

/** D1 caps bound parameters at 100 per query; each activity binds 14, so 7 rows
 * is 98. Adding another column means dropping this to 6. */
const ROWS_PER_INSERT = 7

const COLUMNS =
  'id, name, sport_type, kind, start_date, started_at, distance_mi, elevation_ft, ' +
  'moving_time, elapsed_time, trainer, commute, avg_hr, max_hr'

export interface SyncResult {
  mode: 'incremental' | 'backfill' | 'refresh' | 'recompute'
  /** refresh only: the page this pass stopped after, to resume from. */
  page?: number
  /** Activities returned by Strava this run. */
  seen: number
  /** Of those, ones the archive had not stored before. */
  added: number
  /**
   * Rows the write actually moved — new ones plus genuine edits. The overlap
   * window means `seen` is mostly rows identical to what is already stored, so
   * this is the number that says whether the run did anything.
   */
  changed: number
  /** Whether the totals were rebuilt. False on a run that changed nothing. */
  recomputed: boolean
  /** Backfill only: false while there is still older history to walk. */
  complete: boolean
}

export async function sync(
  env: Env,
  options: { backfill?: boolean; refresh?: boolean; recompute?: boolean; page?: number } = {},
): Promise<SyncResult> {
  // Rebuild totals from the archive without touching Strava — for when the shape
  // of the stats changed but the rows did not.
  if (options.recompute) {
    await recomputeStats(env.DB)
    return { mode: 'recompute', seen: 0, added: 0, changed: 0, recomputed: true, complete: true }
  }

  const token = await accessToken(env)
  const budget = pageBudget(env)
  // Split subqueries: SQLite indexes a lone min/max only, not MIN(x),MAX(x) together.
  const bounds = await env.DB.prepare(
    `SELECT (SELECT MIN(started_at) FROM activities) AS oldest,
            (SELECT MAX(started_at) FROM activities) AS newest`,
  ).first<{ oldest: number | null; newest: number | null }>()

  const collected: SummaryActivity[] = []
  let complete = false
  let lastPage = 0

  if (options.refresh) {
    // Re-pull rows already held, to correct columns the CSV export got wrong
    // (notably start_date, which it can only approximate). Driven by an
    // explicit page number, not the backfill's `before` cursor — every row
    // already exists, so that cursor would never advance.
    const from = Math.max(1, options.page ?? 1)
    for (let i = 0; i < budget; i++) {
      lastPage = from + i
      const batch = await fetchActivities(token, { page: lastPage })
      collected.push(...batch)
      if (batch.length < PER_PAGE) {
        complete = true
        break
      }
    }
  } else if (options.backfill) {
    // No `after`: a first run on an empty archive walks the whole history a
    // budget at a time. `before` is the oldest row held, so each pass resumes
    // where the last stopped with no cursor to persist.
    const before = bounds?.oldest ?? undefined
    for (let page = 1; page <= budget; page++) {
      const batch = await fetchActivities(token, { page, before })
      collected.push(...batch)
      if (batch.length < PER_PAGE) {
        complete = true
        break
      }
    }
  } else {
    const after = bounds?.newest ? bounds.newest - OVERLAP_SECONDS : undefined
    for (let page = 1; page <= budget; page++) {
      const batch = await fetchActivities(token, { page, after })
      collected.push(...batch)
      if (batch.length < PER_PAGE) {
        complete = true
        break
      }
    }
  }

  const added = await countNew(env.DB, collected)
  const changed = await writeActivities(env.DB, collected)

  // Recomputing scans the table twice, so skip it unless a row actually moved
  // — see STATS_MAX_AGE for why it still happens on a quiet day.
  const recomputed = changed > 0 || (await statsStale(env.DB))
  if (recomputed) await recomputeStats(env.DB)

  const mode = options.refresh ? 'refresh' : options.backfill ? 'backfill' : 'incremental'
  return {
    mode,
    seen: collected.length,
    added,
    changed,
    recomputed,
    complete,
    ...(options.refresh && { page: lastPage }),
  }
}

/** How many of these the archive has never stored, for a run count that means something. */
async function countNew(db: D1Database, activities: SummaryActivity[]): Promise<number> {
  if (!activities.length) return 0
  const existing = new Set<string>()
  // Chunked to stay under D1's 100-parameter cap.
  for (let i = 0; i < activities.length; i += 90) {
    const ids = activities.slice(i, i + 90).map((a) => a.id)
    const { results } = await db
      .prepare(`SELECT id FROM activities WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ id: string }>()
    for (const row of results ?? []) existing.add(row.id)
  }
  return activities.filter((a) => !existing.has(a.id)).length
}

/** Columns the upsert overwrites and compares on — everything but the key. */
const MUTABLE = [
  'name',
  'sport_type',
  'kind',
  'start_date',
  'started_at',
  'distance_mi',
  'elevation_ft',
  'moving_time',
  'elapsed_time',
  'trainer',
  'commute',
  'avg_hr',
  'max_hr',
] as const

/**
 * Store the fetched activities, and report how many rows actually moved.
 *
 * Upsert guarded by a WHERE comparing every column, not a bare INSERT OR
 * REPLACE: the incremental pull re-offers a week of overlap every run, so most
 * rows are byte-identical, and REPLACE would rewrite them all with no way to
 * tell a real edit from the overlap. The guard makes RETURNING yield only rows
 * that changed, so a no-op run can skip recomputing totals.
 *
 * `IS NOT` rather than `<>`, since `<>` against a NULL is NULL, not true, and
 * a column moving to/from NULL is exactly an edit.
 */
async function writeActivities(db: D1Database, activities: SummaryActivity[]): Promise<number> {
  if (!activities.length) return 0

  const assignments = MUTABLE.map((c) => `${c} = excluded.${c}`).join(', ')
  const differs = MUTABLE.map((c) => `activities.${c} IS NOT excluded.${c}`).join(' OR ')

  const statements: D1PreparedStatement[] = []
  for (let i = 0; i < activities.length; i += ROWS_PER_INSERT) {
    const chunk = activities.slice(i, i + ROWS_PER_INSERT)
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const values = chunk.flatMap((a) => [
      a.id,
      a.name,
      a.sportType,
      a.kind,
      a.startDate,
      a.startedAt,
      a.distanceMi,
      a.elevationFt,
      a.movingTime,
      a.elapsedTime,
      a.trainer ? 1 : 0,
      a.commute ? 1 : 0,
      // Null, not 0: an activity recorded without a monitor has no heart rate,
      // and a zero would average in as if the heart had stopped.
      a.avgHr,
      a.maxHr,
    ])
    // Strava is the authority on every column, so an edit upstream — a rename,
    // a corrected sport type — has to land. The WHERE only skips the write when
    // there is nothing to change.
    statements.push(
      db
        .prepare(
          `INSERT INTO activities (${COLUMNS}) VALUES ${placeholders}
           ON CONFLICT(id) DO UPDATE SET ${assignments}
           WHERE ${differs}
           RETURNING id`,
        )
        .bind(...values),
    )
  }
  const written = await db.batch<{ id: string }>(statements)
  return written.reduce((n, r) => n + (r.results?.length ?? 0), 0)
}

// How long totals may go without a recompute, however quiet Strava is. The
// `changed > 0` guard only sees rows this sync wrote, so an out-of-band edit
// (e.g. scripts/moving-recategorize.sql) would otherwise leave totals wrong
// indefinitely. This floor bounds that to a day, skipping ~47 of 48 runs.
const STATS_MAX_AGE = 24 * 60 * 60

/** Whether the stored totals are old enough to rebuild on their own account. */
async function statsStale(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT updated_at FROM stats WHERE id = 1').first<{
    updated_at: number
  }>()
  if (!row) return true
  return Math.floor(Date.now() / 1000) - row.updated_at >= STATS_MAX_AGE
}

async function recomputeStats(db: D1Database): Promise<void> {
  const [totals, byYear] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS activities,
                COALESCE(SUM(kind IN ('ride', 'ebike')), 0) AS rides,
                COALESCE(SUM(kind = 'lift'), 0) AS lifts,
                COALESCE(SUM(distance_mi), 0) AS distance_mi,
                COALESCE(SUM(moving_time), 0) AS moving_time
         FROM activities`,
      )
      .first<{
        activities: number
        rides: number
        lifts: number
        distance_mi: number
        moving_time: number
      }>(),
    db
      .prepare(
        `SELECT substr(start_date, 1, 4) AS year,
                COUNT(*) AS activities,
                COALESCE(SUM(kind IN ('ride', 'ebike')), 0) AS rides,
                COALESCE(SUM(kind = 'lift'), 0) AS lifts,
                COALESCE(SUM(distance_mi), 0) AS distance_mi,
                COALESCE(SUM(CASE WHEN kind IN ('ride', 'ebike') THEN distance_mi ELSE 0 END), 0)
                  AS bike_miles,
                COALESCE(SUM(kind = 'run'), 0) AS runs,
                COALESCE(SUM(CASE WHEN kind = 'run' THEN distance_mi ELSE 0 END), 0) AS run_miles
         FROM activities GROUP BY year`,
      )
      .all<{
        year: string
        activities: number
        rides: number
        lifts: number
        distance_mi: number
        bike_miles: number
        runs: number
        run_miles: number
      }>(),
  ])

  const years: Record<string, unknown> = {}
  for (const row of byYear.results ?? []) {
    if (!row.year) continue
    years[row.year] = {
      activities: row.activities,
      rides: row.rides,
      lifts: row.lifts,
      distanceMi: Math.round(row.distance_mi * 10) / 10,
      bikeMiles: Math.round(row.bike_miles * 10) / 10,
      runs: row.runs,
      runMiles: Math.round(row.run_miles * 10) / 10,
    }
  }

  await db
    .prepare(
      `UPDATE stats SET activities = ?1, rides = ?2, lifts = ?3, distance_mi = ?4,
         moving_time = ?5, by_year = ?6, updated_at = ?7
       WHERE id = 1`,
    )
    .bind(
      totals?.activities ?? 0,
      totals?.rides ?? 0,
      totals?.lifts ?? 0,
      Math.round((totals?.distance_mi ?? 0) * 10) / 10,
      totals?.moving_time ?? 0,
      JSON.stringify(years),
      Math.floor(Date.now() / 1000),
    )
    .run()
}
