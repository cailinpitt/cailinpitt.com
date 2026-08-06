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

/** D1 caps bound parameters at 100 per query; each activity binds 13. */
const ROWS_PER_INSERT = 7

const COLUMNS =
  'id, name, sport_type, kind, start_date, started_at, distance_mi, elevation_ft, ' +
  'moving_time, elapsed_time, trainer, commute'

export interface SyncResult {
  mode: 'incremental' | 'backfill' | 'refresh'
  /** refresh only: the page this pass stopped after, to resume from. */
  page?: number
  /** Activities returned by Strava this run. */
  seen: number
  /** Of those, ones the archive had not stored before. */
  added: number
  /** Backfill only: false while there is still older history to walk. */
  complete: boolean
}

export async function sync(
  env: Env,
  options: { backfill?: boolean; refresh?: boolean; page?: number } = {},
): Promise<SyncResult> {
  const token = await accessToken(env)
  const budget = pageBudget(env)
  const bounds = await env.DB.prepare(
    'SELECT MIN(started_at) AS oldest, MAX(started_at) AS newest FROM activities',
  ).first<{ oldest: number | null; newest: number | null }>()

  const collected: SummaryActivity[] = []
  let complete = false
  let lastPage = 0

  if (options.refresh) {
    // Re-pull rows we already hold, to correct columns the export got wrong —
    // notably start_date, which the CSV can only approximate because it carries
    // no local timestamp. Driven by an explicit page number rather than the
    // `before` cursor the backfill uses: every row already exists, so the
    // oldest-row cursor would never advance.
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
    // No `after`, so a first run on an empty archive walks the whole history a
    // budget at a time. `before` is the oldest row we hold, which makes each
    // pass resume where the last one stopped with no cursor to persist.
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
  await writeActivities(env.DB, collected)
  await recomputeStats(env.DB)

  const mode = options.refresh ? 'refresh' : options.backfill ? 'backfill' : 'incremental'
  return { mode, seen: collected.length, added, complete, ...(options.refresh && { page: lastPage }) }
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

async function writeActivities(db: D1Database, activities: SummaryActivity[]): Promise<void> {
  if (!activities.length) return

  const statements: D1PreparedStatement[] = []
  for (let i = 0; i < activities.length; i += ROWS_PER_INSERT) {
    const chunk = activities.slice(i, i + ROWS_PER_INSERT)
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
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
    ])
    // REPLACE, not IGNORE: Strava is the authority on every column, and a
    // rename or corrected sport type arrives as an edit to a stored row.
    statements.push(
      db
        .prepare(`INSERT OR REPLACE INTO activities (${COLUMNS}) VALUES ${placeholders}`)
        .bind(...values),
    )
  }
  await db.batch(statements)
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
                COALESCE(SUM(distance_mi), 0) AS distance_mi
         FROM activities GROUP BY year`,
      )
      .all<{
        year: string
        activities: number
        rides: number
        lifts: number
        distance_mi: number
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
