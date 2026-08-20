// The daily pull: Letterboxd RSS → films, plus poster art into R2.
//
// Every write is an upsert, not a replace (see schema.sql), and the run stays
// inside the Workers free plan's 50 subrequests per invocation — `fetch()`, D1,
// and R2 calls all counted together.

import { fetchDiary, type DiaryEntry } from './letterboxd'
import { mirrorImage } from './images'

// D1 caps bound parameters at 100 per query; each film binds 13, so 7 rows
// (91 parameters) is the most that fits.
const ROWS_PER_INSERT = 7

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

export async function sync(env: Env): Promise<SyncResult> {
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

  await writeFilms(env.DB, entries, posters)
  await recomputeStats(env.DB)

  return {
    added: entries.filter((e) => !existing.has(e.id)).length,
    seen: entries.length,
    postersMirrored: mirrored,
    // Anything still unmirrored (over budget, or a fetch that failed) is picked
    // up by the next run; the card renders without art until then.
    postersRemaining: pending.filter((source) => !posters.has(source)).length,
  }
}

async function writeFilms(
  db: D1Database,
  entries: DiaryEntry[],
  posters: Map<string, string>,
): Promise<void> {
  if (!entries.length) return

  const COLUMNS =
    'id, guid, title, year, slug, watched_date, rewatch, rating, liked, tmdb_id, poster, poster_source, published_at'

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
    // REPLACE rather than IGNORE: a rating or a review added days after the
    // fact arrives as an edit to an entry already stored, and the feed is the
    // authority on every column here.
    statements.push(
      db.prepare(`INSERT OR REPLACE INTO films (${COLUMNS}) VALUES ${placeholders}`).bind(...values),
    )
  }
  await db.batch(statements)
}

// Rebuild `stats`. Unlike worker-reading, this can't be computed from rows in
// memory — the sync only sees the newest 50 entries — so it's two aggregate
// queries once a day, kept off the read path by the stats table.
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
