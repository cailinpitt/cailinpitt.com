// The hourly pull: Letterboxd RSS → films, plus poster art into R2.
//
// Every write is an upsert guarded by a WHERE comparing every column (see
// schema.sql and writeFilms), so the feed's 50-entry overlap — mostly rows
// byte-identical to what is already stored — writes nothing on a quiet run and
// the totals are only recomputed when a row actually moved. The run stays inside
// the Workers free plan's 50 subrequests per invocation — `fetch()`, D1, and R2
// calls all counted together.

import { fetchDiary, type DiaryEntry } from './letterboxd'
import { mirrorImage } from './images'

// D1 caps bound parameters at 100 per query; each film binds 13, so 7 rows
// (91 parameters) is the most that fits.
const ROWS_PER_INSERT = 7

// Every column except the primary key — the set writeFilms() upserts and diffs.
const MUTABLE = [
  'guid',
  'title',
  'year',
  'slug',
  'watched_date',
  'rewatch',
  'rating',
  'liked',
  'tmdb_id',
  'poster',
  'poster_source',
  'published_at',
] as const

// Longest the totals may go without a recompute, however quiet Letterboxd is.
// The `changed > 0` guard only sees rows this run wrote, so an out-of-band edit
// (a CSV backfill loaded straight into D1) would otherwise leave the totals
// wrong until the next diary entry. Matches worker-moving's STATS_MAX_AGE.
const STATS_MAX_AGE = 24 * 60 * 60

// Posters mirrored per run: 2 subrequests each, and the rest of a run spends
// ~6, leaving headroom under the 50-subrequest free-plan ceiling. Leftovers
// are picked up next run. Raise past archive size on Workers Paid to backfill
// in one pass.
function mirrorBudget(env: Env): number {
  const configured = Number(env.MIRROR_BUDGET)
  return Number.isFinite(configured) && configured > 0 ? configured : 15
}

export interface SyncResult {
  /** Entries in the feed that D1 had not seen before. */
  added: number
  /** Entries in the feed at all — the window, currently 50. */
  seen: number
  /** Rows the write actually moved: new entries plus genuine edits. */
  changed: number
  /** Whether the totals were rebuilt. False on a run that changed nothing. */
  recomputed: boolean
  postersMirrored: number
  postersRemaining: number
}

/** poster_source → the /images/watching/… path it was already mirrored to. */
async function knownPosters(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT poster_source, poster FROM films
       WHERE poster IS NOT NULL AND poster_source IS NOT NULL`,
    )
    .all<{ poster_source: string; poster: string }>()
  return new Map((results ?? []).map((r) => [r.poster_source, r.poster]))
}

export async function sync(
  env: Env,
  options: { recompute?: boolean } = {},
): Promise<SyncResult> {
  // Rebuild the totals from the archive without touching Letterboxd — for after
  // a CSV backfill, or when the shape of `stats` changed but the rows did not.
  if (options.recompute) {
    await recomputeStats(env.DB)
    return { added: 0, seen: 0, changed: 0, recomputed: true, postersMirrored: 0, postersRemaining: 0 }
  }

  const entries = await fetchDiary(env.LETTERBOXD_USER)

  // Reuse what's already mirrored so a steady-state run makes no image
  // subrequests at all, and only genuinely new posters cost anything.
  const posters = await knownPosters(env.DB)
  const pending = [...new Set(entries.map((e) => e.posterSource).filter((s): s is string => !!s))]
    .filter((source) => !posters.has(source))

  let mirrored = 0
  for (const source of pending.slice(0, mirrorBudget(env))) {
    const path = await mirrorImage(env, source)
    if (path) {
      posters.set(source, path)
      mirrored++
    }
  }

  // Which of these the database has not seen, purely so the run can report a
  // number that means something. One indexed lookup per entry would be 50 D1
  // calls; this is a single scan of at most 50 ids.
  const ids = entries.map((e) => e.id)
  const existing = new Set<string>()
  if (ids.length) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM films WHERE id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(...ids)
      .all<{ id: string }>()
    for (const row of results ?? []) existing.add(row.id)
  }

  const changed = await writeFilms(env.DB, entries, posters)

  // Recomputing scans the whole archive twice, so skip it unless a row moved —
  // with a daily floor (see STATS_MAX_AGE) so an out-of-band edit still lands.
  const recomputed = changed > 0 || (await statsStale(env.DB))
  if (recomputed) await recomputeStats(env.DB)

  return {
    added: entries.filter((e) => !existing.has(e.id)).length,
    seen: entries.length,
    changed,
    recomputed,
    postersMirrored: mirrored,
    // Anything still unmirrored (over budget, or a fetch that failed) is picked
    // up by the next run; the card renders without art until then.
    postersRemaining: pending.filter((source) => !posters.has(source)).length,
  }
}

/**
 * Store the feed entries, and report how many rows actually moved.
 *
 * Upsert guarded by a WHERE comparing every column, not a bare INSERT OR
 * REPLACE: the feed re-offers its whole 50-entry window every run, so most rows
 * are byte-identical to what is stored, and REPLACE would delete + re-insert
 * every one of them (and its index entry) on every hourly tick. The guard makes
 * RETURNING yield only rows that changed — a rating or review added days later
 * still lands, a quiet run writes nothing.
 *
 * `IS NOT` rather than `<>`, since `<>` against NULL is NULL, not true, and a
 * column moving to/from NULL (a poster finally mirrored, a rating added) is
 * exactly an edit.
 */
async function writeFilms(
  db: D1Database,
  entries: DiaryEntry[],
  posters: Map<string, string>,
): Promise<number> {
  if (!entries.length) return 0

  const COLUMNS = `id, ${MUTABLE.join(', ')}`
  const assignments = MUTABLE.map((c) => `${c} = excluded.${c}`).join(', ')
  const differs = MUTABLE.map((c) => `films.${c} IS NOT excluded.${c}`).join(' OR ')

  const statements: D1PreparedStatement[] = []
  for (let i = 0; i < entries.length; i += ROWS_PER_INSERT) {
    const chunk = entries.slice(i, i + ROWS_PER_INSERT)
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const values = chunk.flatMap((e) => [
      e.id,
      e.guid,
      e.title,
      e.year,
      e.slug,
      e.watchedDate,
      e.rewatch ? 1 : 0,
      e.rating,
      e.liked ? 1 : 0,
      e.tmdbId,
      e.posterSource ? (posters.get(e.posterSource) ?? null) : null,
      e.posterSource,
      e.publishedAt,
    ])
    statements.push(
      db
        .prepare(
          `INSERT INTO films (${COLUMNS}) VALUES ${placeholders}
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

/** Whether the stored totals are old enough to rebuild on their own account. */
async function statsStale(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT updated_at FROM stats WHERE id = 1').first<{
    updated_at: number
  }>()
  if (!row) return true
  return Math.floor(Date.now() / 1000) - row.updated_at >= STATS_MAX_AGE
}

// Rebuild `stats`. Unlike worker-reading, this can't be computed from rows in
// memory — the sync only sees the newest 50 entries — so it's two aggregate
// scans of the archive, kept off the read path by the stats table and only run
// when writeFilms() moved a row (or the daily floor fires).
async function recomputeStats(db: D1Database): Promise<void> {
  const [totals, byYear] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS films,
                COALESCE(SUM(rewatch), 0) AS rewatches,
                COUNT(rating) AS rated,
                COALESCE(SUM(rating), 0) AS rating_sum
         FROM films`,
      )
      .first<{ films: number; rewatches: number; rated: number; rating_sum: number }>(),
    db
      .prepare(
        `SELECT substr(watched_date, 1, 4) AS year,
                COUNT(*) AS films,
                COALESCE(SUM(rewatch), 0) AS rewatches
         FROM films GROUP BY year`,
      )
      .all<{ year: string; films: number; rewatches: number }>(),
  ])

  const years: Record<string, { films: number; rewatches: number }> = {}
  for (const row of byYear.results ?? []) {
    if (row.year) years[row.year] = { films: row.films, rewatches: row.rewatches }
  }

  await db
    .prepare(
      `UPDATE stats SET films = ?1, rewatches = ?2, rated = ?3, rating_sum = ?4,
         by_year = ?5, updated_at = ?6
       WHERE id = 1`,
    )
    .bind(
      totals?.films ?? 0,
      totals?.rewatches ?? 0,
      totals?.rated ?? 0,
      totals?.rating_sum ?? 0,
      JSON.stringify(years),
      Math.floor(Date.now() / 1000),
    )
    .run()
}
