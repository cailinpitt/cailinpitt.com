// Client for the reading API (Cloudflare Worker in /worker-reading), fetched in the browser
// like /listening. Interfaces mirror the Worker's by hand — not a shared package.

import { imageUrl } from './images'

const API_BASE = import.meta.env.VITE_READING_API ?? 'https://reading.cailinpitt.com'

/** hardcover.app user_books.status_id. Only these two are shown on the page. */
export const STATUS_READING = 2
export const STATUS_READ = 3

export interface Book {
  userBookId: number
  /** user_book_reads.id, or 0 when no session was recorded. Re-reads are rows. */
  readId: number
  title: string
  authors: string | null
  slug: string | null
  /** `/images/reading/…` on R2, or null if the cover isn't mirrored yet. */
  cover: string | null
  pages: number | null
  rating: number | null
  statusId: number
  /** YYYY-MM-DD — hardcover stores dates, not timestamps. */
  startedAt: string | null
  finishedAt: string | null
}

export interface Article {
  id: string
  url: string
  title: string | null
  site: string | null
  excerpt: string | null
  /** `/images/reading/…` on R2 — the page's own copy of the social card. */
  image: string | null
  note: string | null
  readAt: number
}

export interface ArticlePage {
  articles: Article[]
  /** Opaque; pass straight back to fetchOlderArticles. Null means no more. */
  nextCursor: string | null
}

export interface BookPage {
  books: Book[]
  /** Opaque; pass straight back to fetchOlderBooks. Null means no more. */
  nextCursor: string | null
}

export interface ReadingBundle extends ArticlePage {
  updatedAt: number
  currentlyReading: Book[]
  /** First page of finished books, newest first. */
  finishedBooks: Book[]
  nextBookCursor: string | null
  counts: {
    booksRead: number
    booksThisYear: number
    pagesThisYear: number
    articles: number
  }
}

/** Lightweight payload for the homepage strip (see /now.json). */
export interface ReadingNow {
  currentlyReading: Book[]
  /** Shown when nothing is in progress, so the strip is never empty. */
  lastFinished: Book | null
  /** Most recent article, but only if saved today. Null on a quiet day. */
  todaysArticle: Article | null
  updatedAt: number
}

export async function fetchReadingNow(signal?: AbortSignal): Promise<ReadingNow> {
  const res = await fetch(`${API_BASE}/now.json`, { signal })
  if (!res.ok) throw new Error(`Reading API ${res.status}`)
  return res.json() as Promise<ReadingNow>
}

export async function fetchReading(signal?: AbortSignal): Promise<ReadingBundle> {
  const res = await fetch(`${API_BASE}/reading.json`, { signal })
  if (!res.ok) throw new Error(`Reading API ${res.status}`)
  return res.json() as Promise<ReadingBundle>
}

export async function fetchOlderBooks(
  cursor: string,
  limit = 24,
  signal?: AbortSignal,
): Promise<BookPage> {
  const res = await fetch(`${API_BASE}/books?cursor=${encodeURIComponent(cursor)}&limit=${limit}`, {
    signal,
  })
  if (!res.ok) throw new Error(`Reading API ${res.status}`)
  return res.json() as Promise<BookPage>
}

export async function fetchOlderArticles(
  cursor: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<ArticlePage> {
  const res = await fetch(
    `${API_BASE}/articles?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
    { signal },
  )
  if (!res.ok) throw new Error(`Reading API ${res.status}`)
  return res.json() as Promise<ArticlePage>
}

/** Covers and social cards are R2 paths; everything else passes through. */
export const readingImage = (src: string | null): string | null => imageUrl(src ?? undefined) ?? null

export const hardcoverUrl = (book: Book): string | null =>
  book.slug ? `https://hardcover.app/books/${book.slug}` : null

/** Google's favicon service, keyed by hostname. Null on an unparseable URL. */
export function faviconUrl(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    return `https://www.google.com/s2/favicons?sz=32&domain=${hostname}`
  } catch {
    return null
  }
}

// Hardcover allows half stars; rounded up here rather than adding a third glyph, since the
// accessible label carries the exact value anyway.
export function stars(rating: number | null): string | null {
  if (rating == null || rating <= 0) return null
  const filled = Math.min(5, Math.round(rating))
  return '★'.repeat(filled) + '☆'.repeat(5 - filled)
}

// The API already returns books in finish-date order, so this just walks once and starts a
// new group on year change.
export function booksByYear(books: Book[]): { year: string; books: Book[] }[] {
  const years: { year: string; books: Book[] }[] = []
  for (const book of books) {
    const year = book.finishedAt?.slice(0, 4)
    if (!year) continue
    const last = years[years.length - 1]
    if (last?.year === year) last.books.push(book)
    else years.push({ year, books: [book] })
  }
  return years
}

/** "June 9, 2025" from a YYYY-MM-DD key, without a timezone slip. */
const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

export function formatBookDate(date: string | null): string | null {
  if (!date) return null
  // Parse at noon UTC so the formatter can't push it onto the adjacent day.
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : dateFmt.format(parsed)
}
