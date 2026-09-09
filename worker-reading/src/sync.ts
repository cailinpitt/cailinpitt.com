// Hardcover → D1 sync, on an hourly cron. Hardcover rows can be edited or
// deleted, so this is a full replace, not an append: fetch the whole library,
// DELETE + re-insert in one atomic batch. Cheaper and more correct than diffing
// at this size, and why there's no separate backfill script — the first run
// imports everything.
//
// The rebuild is gated on a fingerprint (see syncBooks): the library changes a
// few times a week, so running the ~400-row replace every hour — each row
// touching several indexes — was tens of thousands of D1 row-writes a day for
// nothing.

import { fetchLibrary, fetchUserId, type BookRow } from './hardcover'
import { sha256Hex } from './hash'
import { mirrorImage } from './images'

/**
 * Rows per INSERT statement. D1 caps bound parameters at 100 per query and each
 * row binds 13, so 7 rows (91 parameters) is the most that fits.
 */
const ROWS_PER_INSERT = 7

const BOOK_COLUMNS =
  'user_book_id, read_id, book_id, title, authors, slug, cover, cover_source, pages, rating, status_id, started_at, finished_at'

/**
 * Longest the totals may go unwritten while the library itself is unchanged.
 * Bounds how long a manual edit to `books`, or an `articles` increment the email
 * ingest somehow missed, can leave `stats` wrong. Matches worker-moving.
 */
const STATS_MAX_AGE = 24 * 60 * 60

export interface SyncResult {
  books: number
  rows: number
  /** Whether this run rewrote the `books` table (false when the fingerprint matched). */
  rebuilt: boolean
  coversMirrored: number
  coversRemaining: number
}

// Unmirrored covers carry over to the next run: free-plan Workers get 50
// subrequests per invocation and each mirror costs 2. Raise on Workers Paid
// via the MIRROR_BUDGET var — see wrangler.jsonc.
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

  // Rebuild `books` only when what we would write differs from what the last
  // sync wrote; otherwise just refresh the totals, and only on the daily floor.
  const fingerprint = await libraryFingerprint(rows, covers)
  const meta = await env.DB.prepare(
    'SELECT library_hash, updated_at FROM stats WHERE id = 1',
  ).first<{ library_hash: string | null; updated_at: number }>()

  const changed = meta?.library_hash !== fingerprint
  const stale = !meta || Math.floor(Date.now() / 1000) - meta.updated_at >= STATS_MAX_AGE

  if (changed) await rebuildBooks(env.DB, rows, covers, fingerprint)
  else if (stale) await reconcileStats(env.DB, rows, fingerprint)

  return {
    books: new Set(rows.map((r) => r.userBookId)).size,
    rows: rows.length,
    rebuilt: changed,
    coversMirrored: mirrored,
    // Anything still unmirrored (over budget, or a fetch that failed) is simply
    // picked up by the next run; the card renders without art until then.
    coversRemaining: pending.filter((source) => !covers.has(source)).length,
  }
}

// Totals for `stats`, derived from rows already in memory — zero extra D1
// reads, unlike the COUNT(*) subqueries they replace.
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

/**
 * The column values for one row, in `BOOK_COLUMNS` order. Shared by the batch
 * insert and the fingerprint so the two can never disagree about what a sync
 * would persist.
 */
function bookValues(r: BookRow, covers: Map<string, string>): (string | number | null)[] {
  return [
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
  ]
}

/**
 * SHA-256 over exactly what rebuildBooks() would store — every column of every
 * row, including the resolved cover path, so a newly mirrored cover still counts
 * as a change. Rows are sorted by primary key first: Hardcover's order is stable
 * today, but the fingerprint must not depend on that.
 */
function libraryFingerprint(rows: BookRow[], covers: Map<string, string>): Promise<string> {
  const tuples = rows
    .map((r) => bookValues(r, covers))
    .sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]))
  return sha256Hex(JSON.stringify(tuples))
}

/**
 * Full rebuild: DELETE + re-insert the library and recompute the totals, all in
 * one atomic D1 batch so the table is never observed empty between the two.
 */
async function rebuildBooks(
  db: D1Database,
  rows: BookRow[],
  covers: Map<string, string>,
  fingerprint: string,
): Promise<void> {
  const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM books')]

  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT)
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    statements.push(
      db
        .prepare(`INSERT OR REPLACE INTO books (${BOOK_COLUMNS}) VALUES ${placeholders}`)
        .bind(...chunk.flatMap((r) => bookValues(r, covers))),
    )
  }

  statements.push(statsStatement(db, rows, fingerprint))
  await db.batch(statements)
}

/**
 * Refresh the totals row without touching `books` — runs on the daily floor when
 * the library is unchanged, so a manual edit still reconciles and `articles`
 * (incremented on ingest) can't drift forever.
 */
async function reconcileStats(db: D1Database, rows: BookRow[], fingerprint: string): Promise<void> {
  await statsStatement(db, rows, fingerprint).run()
}

function statsStatement(db: D1Database, rows: BookRow[], fingerprint: string): D1PreparedStatement {
  const { booksRead, byYear } = summarize(rows)
  // `articles` is reconciled here rather than incremented, which repairs any
  // increment the email ingest may have missed.
  return db
    .prepare(
      `UPDATE stats SET books_read = ?1, by_year = ?2,
         articles = (SELECT COUNT(*) FROM articles),
         library_hash = ?3, updated_at = ?4
       WHERE id = 1`,
    )
    .bind(booksRead, byYear, fingerprint, Math.floor(Date.now() / 1000))
}
