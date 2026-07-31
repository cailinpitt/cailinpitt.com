// Daily Hardcover → D1 sync.
//
// Hardcover is the source of truth and rows there can be edited or deleted, so
// this is a full *replace*, not an append: fetch the whole library, then DELETE
// + re-insert inside one atomic D1 batch. At a few hundred books that is both
// cheaper and more correct than diffing, and it is why there is no separate
// backfill script — the first run imports the entire history.

import { fetchLibrary, fetchUserId, type BookRow } from './hardcover'
import { mirrorImage } from './images'

/**
 * Rows per INSERT statement. D1 caps bound parameters at 100 per query and each
 * row binds 13, so 7 rows (91 parameters) is the most that fits.
 */
const ROWS_PER_INSERT = 7

export interface SyncResult {
  books: number
  rows: number
  coversMirrored: number
  coversRemaining: number
}

/**
 * Covers still needing a mirror are carried over to the next run rather than
 * done all at once: on the Workers free plan an invocation gets 50 subrequests
 * (R2/KV/D1 binding calls included) and each mirror costs 2. `MIRROR_BUDGET` is
 * a var so it can be raised on Workers Paid — see wrangler.jsonc.
 */
function mirrorBudget(env: Env): number {
  const configured = Number(env.MIRROR_BUDGET)
  return Number.isFinite(configured) && configured > 0 ? configured : 15
}

/** cover_source → the /images/reading/… path it was already mirrored to. */
async function knownCovers(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT cover_source, cover FROM books
       WHERE cover IS NOT NULL AND cover_source IS NOT NULL`,
    )
    .all<{ cover_source: string; cover: string }>()
  return new Map((results ?? []).map((r) => [r.cover_source, r.cover]))
}

export async function syncBooks(env: Env): Promise<SyncResult> {
  const userId = await fetchUserId(env.HARDCOVER_TOKEN)
  const rows = await fetchLibrary(env.HARDCOVER_TOKEN, userId)

  // Reuse what's already mirrored so a steady-state run makes no image
  // subrequests at all, and only genuinely new covers cost anything.
  const covers = await knownCovers(env.DB)
  const pending = [...new Set(rows.map((r) => r.coverSource).filter((s): s is string => !!s))]
    .filter((source) => !covers.has(source))

  let mirrored = 0
  for (const source of pending.slice(0, mirrorBudget(env))) {
    const path = await mirrorImage(env, source)
    if (path) {
      covers.set(source, path)
      mirrored++
    }
  }

  await writeBooks(env.DB, rows, covers)

  return {
    books: new Set(rows.map((r) => r.userBookId)).size,
    rows: rows.length,
    coversMirrored: mirrored,
    // Anything still unmirrored (over budget, or a fetch that failed) is simply
    // picked up by the next run; the card renders without art until then.
    coversRemaining: pending.filter((source) => !covers.has(source)).length,
  }
}

/**
 * Totals for the `stats` table, derived from rows already in memory — so
 * maintaining them costs zero D1 reads, unlike the COUNT(*) subqueries they
 * replaced. See the comment on the table in schema.sql.
 */
function summarize(rows: BookRow[]): { booksRead: number; byYear: string } {
  let booksRead = 0
  const byYear: Record<string, { books: number; pages: number }> = {}

  for (const row of rows) {
    if (row.statusId !== 3) continue
    booksRead++
    const year = row.finishedAt?.slice(0, 4)
    if (!year) continue // undated; counted in the total, not attributable to a year
    const bucket = (byYear[year] ??= { books: 0, pages: 0 })
    bucket.books++
    bucket.pages += row.pages ?? 0
  }

  return { booksRead, byYear: JSON.stringify(byYear) }
}

async function writeBooks(
  db: D1Database,
  rows: BookRow[],
  covers: Map<string, string>,
): Promise<void> {
  const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM books')]

  const COLUMNS =
    'user_book_id, read_id, book_id, title, authors, slug, cover, cover_source, pages, rating, status_id, started_at, finished_at'

  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT)
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const values = chunk.flatMap((r) => [
      r.userBookId,
      r.readId,
      r.bookId,
      r.title,
      r.authors,
      r.slug,
      r.coverSource ? (covers.get(r.coverSource) ?? null) : null,
      r.coverSource,
      r.pages,
      r.rating,
      r.statusId,
      r.startedAt,
      r.finishedAt,
    ])
    statements.push(
      db.prepare(`INSERT OR REPLACE INTO books (${COLUMNS}) VALUES ${placeholders}`).bind(...values),
    )
  }

  // Recompute the totals in the same transaction as the rows they describe, so
  // the two can never disagree. `articles` is reconciled here rather than
  // incremented, which repairs any increment a save may have missed.
  const { booksRead, byYear } = summarize(rows)
  statements.push(
    db
      .prepare(
        `UPDATE stats SET books_read = ?1, by_year = ?2,
           articles = (SELECT COUNT(*) FROM articles), updated_at = ?3
         WHERE id = 1`,
      )
      .bind(booksRead, byYear, Math.floor(Date.now() / 1000)),
  )

  // One batch, so the table is never observed empty between the delete and the
  // re-insert. D1 runs a batch as a single transaction.
  await db.batch(statements)
}
