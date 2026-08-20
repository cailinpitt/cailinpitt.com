// D1 reads for the /reading API. No precomputed KV blobs, unlike the listening
// worker: at a few hundred books and a few thousand articles every query below
// is a small indexed scan, so building the bundle straight from D1 behind the
// edge cache is simpler and comfortably inside the free tier.

// Paged, not sent whole: the bundle is rebuilt per colo per TTL, so a small
// first page keeps D1 row reads flat as the archive grows.
export const BOOK_PAGE = 24
const MAX_BOOK_PAGE = 100

/** Articles per page, and the ceiling on what a caller may ask for. */
export const ARTICLE_PAGE = 20
const MAX_ARTICLE_PAGE = 50

const BOOK_COLS =
  'user_book_id, read_id, title, authors, slug, cover, pages, rating, status_id, started_at, finished_at'

export interface Book {
  userBookId: number
  readId: number
  title: string
  authors: string | null
  slug: string | null
  cover: string | null
  pages: number | null
  rating: number | null
  statusId: number
  startedAt: string | null
  finishedAt: string | null
}

export interface Article {
  id: string
  url: string
  title: string | null
  site: string | null
  excerpt: string | null
  image: string | null
  note: string | null
  readAt: number
}

export interface BookPage {
  books: Book[]
  /** Opaque; pass straight back to /books. Null means the history is exhausted. */
  nextCursor: string | null
}

export interface ReadingBundle {
  updatedAt: number
  currentlyReading: Book[]
  /** First page of finished books, newest first. Grouped by year on the page. */
  finishedBooks: Book[]
  nextBookCursor: string | null
  articles: Article[]
  nextCursor: string | null
  counts: {
    booksRead: number
    booksThisYear: number
    pagesThisYear: number
    articles: number
  }
}

interface BookRow {
  user_book_id: number
  read_id: number
  title: string
  authors: string | null
  slug: string | null
  cover: string | null
  pages: number | null
  rating: number | null
  status_id: number
  started_at: string | null
  finished_at: string | null
}

interface ArticleRow {
  id: string
  url: string
  title: string | null
  site: string | null
  excerpt: string | null
  image: string | null
  note: string | null
  read_at: number
}

const toBook = (r: BookRow): Book => ({
  userBookId: r.user_book_id,
  readId: r.read_id,
  title: r.title,
  authors: r.authors,
  slug: r.slug,
  cover: r.cover,
  pages: r.pages,
  rating: r.rating,
  statusId: r.status_id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
})

const toArticle = (r: ArticleRow): Article => ({
  id: r.id,
  url: r.url,
  title: r.title,
  site: r.site,
  excerpt: r.excerpt,
  image: r.image,
  note: r.note,
  readAt: r.read_at,
})

// Cursor is composite (`<read_at>:<id>`), not a bare timestamp: two articles
// can share a second, and a `read_at < ?` cursor alone would drop one.
const encodeCursor = (a: Article): string => `${a.readAt}:${a.id}`

function decodeCursor(raw: string | null): { readAt: number; id: string } | null {
  if (!raw) return null
  const at = raw.indexOf(':')
  if (at < 1) return null
  const readAt = Number(raw.slice(0, at))
  const id = raw.slice(at + 1)
  return Number.isFinite(readAt) && id ? { readAt, id } : null
}

// Cursor carries all three sort columns: finished_at is a date, so several
// books routinely share one, and a bare date cursor would drop the rest.
const encodeBookCursor = (b: Book): string => `${b.finishedAt}:${b.userBookId}:${b.readId}`

function decodeBookCursor(raw: string | null): [string, number, number] | null {
  if (!raw) return null
  // finished_at is YYYY-MM-DD and contains no colon, so splitting is unambiguous.
  const parts = raw.split(':')
  if (parts.length !== 3) return null
  const [date, userBookId, readId] = parts
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Number(userBookId))
    ? [date, Number(userBookId), Number(readId)]
    : null
}

export async function fetchFinishedBooks(
  db: D1Database,
  cursor: string | null,
  limit: number,
): Promise<BookPage> {
  const size = Math.min(Math.max(limit, 1), MAX_BOOK_PAGE)
  const from = decodeBookCursor(cursor)

  const ORDER = 'ORDER BY finished_at DESC, user_book_id DESC, read_id DESC'
  const WHERE = 'status_id = 3 AND finished_at IS NOT NULL'

  // Fetch one extra to learn whether another page exists without a COUNT.
  const query = from
    ? db
        .prepare(
          `SELECT ${BOOK_COLS} FROM books
           WHERE ${WHERE} AND (finished_at, user_book_id, read_id) < (?1, ?2, ?3)
           ${ORDER} LIMIT ?4`,
        )
        .bind(from[0], from[1], from[2], size + 1)
    : db.prepare(`SELECT ${BOOK_COLS} FROM books WHERE ${WHERE} ${ORDER} LIMIT ?1`).bind(size + 1)

  const { results } = await query.all<BookRow>()
  const rows = (results ?? []).map(toBook)
  const hasMore = rows.length > size
  const books = hasMore ? rows.slice(0, size) : rows
  return {
    books,
    nextCursor: hasMore && books.length ? encodeBookCursor(books[books.length - 1]) : null,
  }
}

export async function fetchArticles(
  db: D1Database,
  cursor: string | null,
  limit: number,
): Promise<{ articles: Article[]; nextCursor: string | null }> {
  const size = Math.min(Math.max(limit, 1), MAX_ARTICLE_PAGE)
  const from = decodeCursor(cursor)

  // Fetch one extra to learn whether another page exists without a COUNT.
  const query = from
    ? db
        .prepare(
          `SELECT id, url, title, site, excerpt, image, note, read_at FROM articles
           WHERE read_at < ?1 OR (read_at = ?1 AND id < ?2)
           ORDER BY read_at DESC, id DESC LIMIT ?3`,
        )
        .bind(from.readAt, from.id, size + 1)
    : db
        .prepare(
          `SELECT id, url, title, site, excerpt, image, note, read_at FROM articles
           ORDER BY read_at DESC, id DESC LIMIT ?1`,
        )
        .bind(size + 1)

  const { results } = await query.all<ArticleRow>()
  const rows = (results ?? []).map(toArticle)
  const hasMore = rows.length > size
  const articles = hasMore ? rows.slice(0, size) : rows
  return {
    articles,
    nextCursor: hasMore && articles.length ? encodeCursor(articles[articles.length - 1]) : null,
  }
}

export interface ReadingNow {
  currentlyReading: Book[]
  /** Shown when nothing is in progress, so the strip is never empty. */
  lastFinished: Book | null
  /**
   * The most recent article, but only if it was saved *today* — Cailin's today,
   * bucketed against TZ_OFFSET_SECONDS the same way the listening Worker buckets
   * its days. Null on a day with nothing saved, and the homepage simply omits
   * the card rather than showing a stale one from last week.
   */
  todaysArticle: Article | null
  updatedAt: number
}

// Four rows for the homepage bar — not the full bundle, since this is hit on
// every homepage visit and has no business reading 49 rows to render one book.
export async function buildNow(db: D1Database, offsetSeconds: number): Promise<ReadingNow> {
  const now = Math.floor(Date.now() / 1000)
  const startOfToday = Math.floor((now + offsetSeconds) / 86400) * 86400 - offsetSeconds

  const [current, finished, article] = await Promise.all([
    db
      .prepare(
        `SELECT ${BOOK_COLS} FROM books WHERE status_id = 2
         ORDER BY started_at IS NULL, started_at DESC LIMIT 3`,
      )
      .all<BookRow>(),
    db
      .prepare(
        `SELECT ${BOOK_COLS} FROM books
         WHERE status_id = 3 AND finished_at IS NOT NULL
         ORDER BY finished_at DESC, user_book_id DESC, read_id DESC LIMIT 1`,
      )
      .first<BookRow>(),
    db
      .prepare(
        `SELECT id, url, title, site, excerpt, image, note, read_at FROM articles
         WHERE read_at >= ?1 ORDER BY read_at DESC, id DESC LIMIT 1`,
      )
      .bind(startOfToday)
      .first<ArticleRow>(),
  ])

  return {
    currentlyReading: (current.results ?? []).map(toBook),
    lastFinished: finished ? toBook(finished) : null,
    todaysArticle: article ? toArticle(article) : null,
    updatedAt: now,
  }
}

interface YearTotals {
  books: number
  pages: number
}

function yearFrom(byYear: string | undefined, year: number): YearTotals {
  if (!byYear) return { books: 0, pages: 0 }
  try {
    const parsed = JSON.parse(byYear) as Record<string, Partial<YearTotals>>
    const found = parsed[String(year)]
    return { books: found?.books ?? 0, pages: found?.pages ?? 0 }
  } catch {
    return { books: 0, pages: 0 }
  }
}

export async function buildBundle(db: D1Database, year: number): Promise<ReadingBundle> {
  const [current, finished, counts, page] = await Promise.all([
    db
      .prepare(
        // NULL dates sort last: a book you started without recording a date
        // still belongs in the list, just not at the top.
        `SELECT ${BOOK_COLS} FROM books WHERE status_id = 2
         ORDER BY started_at IS NULL, started_at DESC`,
      )
      .all<BookRow>(),
    fetchFinishedBooks(db, null, BOOK_PAGE),
    // One row, precomputed by the sync. See the `stats` table in schema.sql for
    // why these are not COUNT(*)/SUM() subqueries over the archive.
    db
      .prepare('SELECT books_read, articles, by_year FROM stats WHERE id = 1')
      .first<{ books_read: number; articles: number; by_year: string }>(),
    fetchArticles(db, null, ARTICLE_PAGE),
  ])

  // A year absent from by_year is genuinely zero — which is what makes the
  // "this year" tiles correct on January 1 rather than showing last year's
  // total until the next sync runs.
  const thisYear = yearFrom(counts?.by_year, year)

  return {
    updatedAt: Math.floor(Date.now() / 1000),
    currentlyReading: (current.results ?? []).map(toBook),
    finishedBooks: finished.books,
    nextBookCursor: finished.nextCursor,
    articles: page.articles,
    nextCursor: page.nextCursor,
    counts: {
      booksRead: counts?.books_read ?? 0,
      booksThisYear: thisYear.books,
      pagesThisYear: thisYear.pages,
      articles: counts?.articles ?? 0,
    },
  }
}
