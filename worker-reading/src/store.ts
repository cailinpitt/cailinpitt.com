// D1 reads for the /reading API. No precomputed KV blobs, unlike the listening
// worker: at a few hundred books and a few thousand articles every query below
// is a small indexed scan, so building the bundle straight from D1 behind the
// edge cache is simpler and comfortably inside the free tier.

import { DEAD_AFTER } from './rot'

// Paged, not sent whole: the bundle is rebuilt per colo per TTL, so a small
// first page keeps D1 row reads flat as the archive grows.
export const BOOK_PAGE = 24
const MAX_BOOK_PAGE = 100

/** Articles per page, and the ceiling on what a caller may ask for. */
export const ARTICLE_PAGE = 20
const MAX_ARTICLE_PAGE = 50

/** Links per page. Same shape as articles; a link row is smaller (no image). */
export const LINK_PAGE = 20
const MAX_LINK_PAGE = 50

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
  /** Prose words on the page; null when unknown. */
  words: number | null
  /** The url has failed DEAD_AFTER checks in a row (see rot.ts). */
  dead: boolean
  /** Wayback snapshot to link instead. Only set when dead. */
  archiveUrl: string | null
}

export interface Link {
  id: string
  url: string
  title: string | null
  site: string | null
  excerpt: string | null
  note: string | null
  savedAt: number
  dead: boolean
  archiveUrl: string | null
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
  links: Link[]
  nextLinkCursor: string | null
  counts: {
    booksRead: number
    booksThisYear: number
    pagesThisYear: number
    articles: number
    links: number
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
  words: number | null
  dead: number
  archive_url: string | null
}

interface LinkRow {
  id: string
  url: string
  title: string | null
  site: string | null
  excerpt: string | null
  note: string | null
  saved_at: number
  dead: number
  archive_url: string | null
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

// archive_url only goes out for a dead row; a live one links to the page itself.
const ROT_COLS = `failures >= ${DEAD_AFTER} AS dead,
  CASE WHEN failures >= ${DEAD_AFTER} THEN archive_url END AS archive_url`

const ARTICLE_COLS = `id, url, title, site, excerpt, image, note, read_at, words, ${ROT_COLS}`

const toArticle = (r: ArticleRow): Article => ({
  id: r.id,
  url: r.url,
  title: r.title,
  site: r.site,
  excerpt: r.excerpt,
  image: r.image,
  note: r.note,
  readAt: r.read_at,
  words: r.words,
  dead: Boolean(r.dead),
  archiveUrl: r.archive_url,
})

const LINK_COLS = `id, url, title, site, excerpt, note, saved_at, ${ROT_COLS}`

const toLink = (r: LinkRow): Link => ({
  id: r.id,
  url: r.url,
  title: r.title,
  site: r.site,
  excerpt: r.excerpt,
  note: r.note,
  savedAt: r.saved_at,
  dead: Boolean(r.dead),
  archiveUrl: r.archive_url,
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

export interface SavedFilter {
  /** Words that must each appear in the title, excerpt, note, or url. */
  q?: string | null
  /** Hostname, matched against the generated `host` column (no "www."). */
  site?: string | null
}

const SEARCH_COLS = ['title', 'excerpt', 'note', 'url']

/** A hostname as the `host` column stores it, or null if it isn't one. */
export function normalizeSite(raw: string | null | undefined): string | null {
  const site = raw?.trim().toLowerCase().replace(/^www\./, '')
  return site && /^[a-z0-9.-]+(:\d+)?$/.test(site) ? site : null
}

// LIKE rather than FTS5: at a few thousand rows a filtered scan is cheap, the
// result is edge-cached per query, and there's no shadow table to keep in step
// with ingest, moves, and deletes.
function filterClauses(filter: SavedFilter | undefined): { where: string[]; params: (string | number)[] } {
  const where: string[] = []
  const params: (string | number)[] = []

  const site = normalizeSite(filter?.site)
  if (site) {
    where.push('host = ?')
    params.push(site)
  }

  const terms = (filter?.q ?? '').trim().slice(0, 100).split(/\s+/).filter(Boolean).slice(0, 5)
  for (const term of terms) {
    const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(`(${SEARCH_COLS.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    params.push(...SEARCH_COLS.map(() => pattern))
  }

  return { where, params }
}

/** One newest-first page of `table`, after `cursor`, narrowed by `filter`. */
async function fetchSavedPage<Row, T>(
  db: D1Database,
  table: 'articles' | 'links',
  tsCol: 'read_at' | 'saved_at',
  cols: string,
  map: (row: Row) => T,
  cursor: string | null,
  size: number,
  filter: SavedFilter | undefined,
): Promise<{ items: T[]; hasMore: boolean }> {
  const { where, params } = filterClauses(filter)
  const from = decodeCursor(cursor)
  if (from) {
    where.push(`(${tsCol} < ? OR (${tsCol} = ? AND id < ?))`)
    params.push(from.readAt, from.readAt, from.id)
  }

  // Fetch one extra to learn whether another page exists without a COUNT.
  const { results } = await db
    .prepare(
      `SELECT ${cols} FROM ${table}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${tsCol} DESC, id DESC LIMIT ?`,
    )
    .bind(...params, size + 1)
    .all<Row>()

  const rows = (results ?? []).map(map)
  return { items: rows.slice(0, size), hasMore: rows.length > size }
}

export async function fetchArticles(
  db: D1Database,
  cursor: string | null,
  limit: number,
  filter?: SavedFilter,
): Promise<{ articles: Article[]; nextCursor: string | null }> {
  const size = Math.min(Math.max(limit, 1), MAX_ARTICLE_PAGE)
  const { items: articles, hasMore } = await fetchSavedPage(
    db, 'articles', 'read_at', ARTICLE_COLS, toArticle, cursor, size, filter,
  )
  return {
    articles,
    nextCursor: hasMore && articles.length ? encodeCursor(articles[articles.length - 1]) : null,
  }
}

/** Articles read in [from, to) — a single indexed range scan, for /timeline's permalink. */
export async function fetchArticlesBetween(
  db: D1Database,
  from: number,
  to: number,
): Promise<Article[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ARTICLE_COLS} FROM articles
       WHERE read_at >= ?1 AND read_at < ?2 ORDER BY read_at DESC, id DESC`,
    )
    .bind(from, to)
    .all<ArticleRow>()
  return (results ?? []).map(toArticle)
}

// Same composite-cursor shape as articles (`<saved_at>:<id>`); decodeCursor is
// generic enough to reuse (its `.readAt` field is just "the timestamp").
const encodeLinkCursor = (l: Link): string => `${l.savedAt}:${l.id}`

export async function fetchLinks(
  db: D1Database,
  cursor: string | null,
  limit: number,
  filter?: SavedFilter,
): Promise<{ links: Link[]; nextCursor: string | null }> {
  const size = Math.min(Math.max(limit, 1), MAX_LINK_PAGE)
  const { items: links, hasMore } = await fetchSavedPage(
    db, 'links', 'saved_at', LINK_COLS, toLink, cursor, size, filter,
  )
  return {
    links,
    nextCursor: hasMore && links.length ? encodeLinkCursor(links[links.length - 1]) : null,
  }
}

/** Links saved in [from, to) — a single indexed range scan, for /timeline's permalink. */
export async function fetchLinksBetween(db: D1Database, from: number, to: number): Promise<Link[]> {
  const { results } = await db
    .prepare(
      `SELECT ${LINK_COLS} FROM links
       WHERE saved_at >= ?1 AND saved_at < ?2 ORDER BY saved_at DESC, id DESC`,
    )
    .bind(from, to)
    .all<LinkRow>()
  return (results ?? []).map(toLink)
}

/** Books finished, or started-and-not-finished, on `date` — matches buildTimeline()'s
 * bucketing (frontend src/lib/timeline.ts) so a permalink day agrees with the paged view. */
export async function fetchBooksOnDate(db: D1Database, date: string): Promise<Book[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOK_COLS} FROM books
       WHERE finished_at = ?1 OR (started_at = ?1 AND finished_at IS NULL)`,
    )
    .bind(date)
    .all<BookRow>()
  return (results ?? []).map(toBook)
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
  /** Most recent link, same "saved today" rule as todaysArticle. */
  todaysLink: Link | null
  updatedAt: number
}

// Four rows for the homepage bar — not the full bundle, since this is hit on
// every homepage visit and has no business reading 49 rows to render one book.
export async function buildNow(db: D1Database, offsetSeconds: number): Promise<ReadingNow> {
  const now = Math.floor(Date.now() / 1000)
  const startOfToday = Math.floor((now + offsetSeconds) / 86400) * 86400 - offsetSeconds

  const [current, finished, article, link] = await Promise.all([
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
        `SELECT ${ARTICLE_COLS} FROM articles
         WHERE read_at >= ?1 ORDER BY read_at DESC, id DESC LIMIT 1`,
      )
      .bind(startOfToday)
      .first<ArticleRow>(),
    db
      .prepare(
        `SELECT ${LINK_COLS} FROM links
         WHERE saved_at >= ?1 ORDER BY saved_at DESC, id DESC LIMIT 1`,
      )
      .bind(startOfToday)
      .first<LinkRow>(),
  ])

  return {
    currentlyReading: (current.results ?? []).map(toBook),
    lastFinished: finished ? toBook(finished) : null,
    todaysArticle: article ? toArticle(article) : null,
    todaysLink: link ? toLink(link) : null,
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
  const [current, finished, counts, page, linkPage] = await Promise.all([
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
      .prepare('SELECT books_read, articles, links, by_year FROM stats WHERE id = 1')
      .first<{ books_read: number; articles: number; links: number; by_year: string }>(),
    fetchArticles(db, null, ARTICLE_PAGE),
    fetchLinks(db, null, LINK_PAGE),
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
    links: linkPage.links,
    nextLinkCursor: linkPage.nextCursor,
    counts: {
      booksRead: counts?.books_read ?? 0,
      booksThisYear: thisYear.books,
      pagesThisYear: thisYear.pages,
      articles: counts?.articles ?? 0,
      links: counts?.links ?? 0,
    },
  }
}

/** Weeks of history in the stats sparkline. */
const STAT_WEEKS = 26
const TOP_SITES = 10

export interface SavedStats {
  total: number
  thisYear: number
  /** Saves per local week, oldest first, the last ending with the current week. */
  weeks: number[]
  /** Local YYYY-MM-DD of the Monday the first week starts on. */
  firstWeek: string
  topSites: { host: string; count: number }[]
  /** 0 = Sunday. Null when nothing is saved. */
  busiestWeekday: number | null
  /** Most consecutive local days with at least one save. */
  longestStreak: number
}

// Reads every timestamp (one covering-index scan) and buckets in JS: at a few
// thousand rows that's cheaper to reason about than four GROUP BYs, and the
// result sits behind a long edge TTL.
export async function buildSavedStats(
  db: D1Database,
  kind: 'articles' | 'links',
  offsetSeconds: number,
  year: number,
): Promise<SavedStats> {
  const tsCol = kind === 'articles' ? 'read_at' : 'saved_at'
  const [times, sites] = await Promise.all([
    db.prepare(`SELECT ${tsCol} AS ts FROM ${kind}`).all<{ ts: number }>(),
    db
      .prepare(
        `SELECT host, COUNT(*) AS count FROM ${kind} WHERE host <> ''
         GROUP BY host ORDER BY count DESC, host LIMIT ?1`,
      )
      .bind(TOP_SITES)
      .all<{ host: string; count: number }>(),
  ])

  const localDay = (ts: number) => Math.floor((ts + offsetSeconds) / 86400)
  // Epoch day 0 was a Thursday: (day + 3) % 7 is 0 on Mondays, (day + 4) % 7 on Sundays.
  const today = localDay(Math.floor(Date.now() / 1000))
  const firstWeek = today - ((today + 3) % 7) - (STAT_WEEKS - 1) * 7

  const weeks = new Array<number>(STAT_WEEKS).fill(0)
  const weekdays = new Array<number>(7).fill(0)
  const days = new Set<number>()
  let thisYear = 0

  const rows = times.results ?? []
  for (const { ts } of rows) {
    const day = localDay(ts)
    days.add(day)
    weekdays[(day + 4) % 7]++
    const week = Math.floor((day - firstWeek) / 7)
    if (week >= 0 && week < STAT_WEEKS) weeks[week]++
    if (new Date(day * 86400 * 1000).getUTCFullYear() === year) thisYear++
  }

  let longestStreak = 0
  let run = 0
  let previous = Number.NaN
  for (const day of [...days].sort((a, b) => a - b)) {
    run = day === previous + 1 ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
    previous = day
  }

  return {
    total: rows.length,
    thisYear,
    weeks,
    firstWeek: new Date(firstWeek * 86400 * 1000).toISOString().slice(0, 10),
    topSites: sites.results ?? [],
    busiestWeekday: rows.length ? weekdays.indexOf(Math.max(...weekdays)) : null,
    longestStreak,
  }
}
