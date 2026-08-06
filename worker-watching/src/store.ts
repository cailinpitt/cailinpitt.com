// D1 reads for the /watching API.
//
// Same shape as worker-reading's store: no precomputed KV blobs, because at a
// few hundred films every query below is a small indexed seek. Building the
// bundle straight from D1 behind the edge cache is simpler than a staleness
// ladder and comfortably inside the free tier.

/** Films per page, and the ceiling on what a caller may ask for. */
export const FILM_PAGE = 24
const MAX_FILM_PAGE = 100

const FILM_COLS = 'id, title, year, slug, watched_date, rewatch, rating, liked, poster'

export interface Film {
  id: string
  title: string
  year: number | null
  slug: string | null
  /** YYYY-MM-DD, as logged on Letterboxd — a date, not a timestamp. */
  watchedDate: string
  rewatch: boolean
  rating: number | null
  liked: boolean
  poster: string | null
}

export interface FilmPage {
  films: Film[]
  /** Opaque; pass straight back to /films. Null means the history is done. */
  nextCursor: string | null
}

export interface WatchingBundle {
  updatedAt: number
  films: Film[]
  nextCursor: string | null
  counts: {
    films: number
    filmsThisYear: number
    rewatches: number
    /** Mean rating across every rated entry, or null before there are any. */
    meanRating: number | null
  }
}

interface FilmRow {
  id: string
  title: string
  year: number | null
  slug: string | null
  watched_date: string
  rewatch: number
  rating: number | null
  liked: number
  poster: string | null
}

const toFilm = (r: FilmRow): Film => ({
  id: r.id,
  title: r.title,
  year: r.year,
  slug: r.slug,
  watchedDate: r.watched_date,
  rewatch: r.rewatch === 1,
  rating: r.rating,
  liked: r.liked === 1,
  poster: r.poster,
})

// ---- pagination ----------------------------------------------------------
//
// The cursor is composite — `<watched_date>:<id>` — for the same reason
// worker-reading's are: the leading column is not unique. Letterboxd logs a
// date, not a timestamp, so several films routinely share one, and a bare date
// cursor would silently drop all but one of them at each page boundary.

const encodeCursor = (f: Film): string => `${f.watchedDate}:${f.id}`

function decodeCursor(raw: string | null): [string, string] | null {
  if (!raw) return null
  const at = raw.indexOf(':')
  if (at < 1) return null
  const date = raw.slice(0, at)
  const id = raw.slice(at + 1)
  // A film id is `<slug>|<date>` and contains no colon, so the first one is
  // unambiguously the separator.
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && id ? [date, id] : null
}

export async function fetchFilms(
  db: D1Database,
  cursor: string | null,
  limit: number,
): Promise<FilmPage> {
  const size = Math.min(Math.max(limit, 1), MAX_FILM_PAGE)
  const from = decodeCursor(cursor)

  const ORDER = 'ORDER BY watched_date DESC, id DESC'
  // Fetch one extra to learn whether another page exists without a COUNT.
  const query = from
    ? db
        .prepare(
          `SELECT ${FILM_COLS} FROM films
           WHERE (watched_date, id) < (?1, ?2) ${ORDER} LIMIT ?3`,
        )
        .bind(from[0], from[1], size + 1)
    : db.prepare(`SELECT ${FILM_COLS} FROM films ${ORDER} LIMIT ?1`).bind(size + 1)

  const { results } = await query.all<FilmRow>()
  const rows = (results ?? []).map(toFilm)
  const hasMore = rows.length > size
  const films = hasMore ? rows.slice(0, size) : rows
  return {
    films,
    nextCursor: hasMore && films.length ? encodeCursor(films[films.length - 1]) : null,
  }
}

// ---- the homepage strip / terminal ---------------------------------------

export interface WatchingNow {
  lastFilm: Film | null
  updatedAt: number
}

/**
 * One row.
 *
 * Deliberately not the full bundle, matching /reading's /now.json: whatever
 * ends up calling this (the terminal's `watching`, a homepage strip later) has
 * no business reading 24 rows to render one line.
 */
export async function buildNow(db: D1Database): Promise<WatchingNow> {
  const film = await db
    .prepare(`SELECT ${FILM_COLS} FROM films ORDER BY watched_date DESC, id DESC LIMIT 1`)
    .first<FilmRow>()

  return {
    lastFilm: film ? toFilm(film) : null,
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

// ---- the bundle ----------------------------------------------------------

interface YearTotals {
  films: number
  rewatches: number
}

function yearFrom(byYear: string | undefined, year: number): YearTotals {
  if (!byYear) return { films: 0, rewatches: 0 }
  try {
    const parsed = JSON.parse(byYear) as Record<string, Partial<YearTotals>>
    const found = parsed[String(year)]
    return { films: found?.films ?? 0, rewatches: found?.rewatches ?? 0 }
  } catch {
    return { films: 0, rewatches: 0 }
  }
}

export async function buildBundle(db: D1Database, year: number): Promise<WatchingBundle> {
  const [page, counts] = await Promise.all([
    fetchFilms(db, null, FILM_PAGE),
    // One row, precomputed by the sync. See the `stats` table in schema.sql for
    // why these are not COUNT(*) subqueries over the archive.
    db
      .prepare('SELECT films, rewatches, rated, rating_sum, by_year FROM stats WHERE id = 1')
      .first<{
        films: number
        rewatches: number
        rated: number
        rating_sum: number
        by_year: string
      }>(),
  ])

  // A year absent from by_year is genuinely zero — which is what makes the
  // "this year" tile correct on January 1 rather than showing last year's total
  // until the next sync runs.
  const thisYear = yearFrom(counts?.by_year, year)
  const rated = counts?.rated ?? 0

  return {
    updatedAt: Math.floor(Date.now() / 1000),
    films: page.films,
    nextCursor: page.nextCursor,
    counts: {
      films: counts?.films ?? 0,
      filmsThisYear: thisYear.films,
      rewatches: counts?.rewatches ?? 0,
      meanRating: rated > 0 ? Math.round(((counts?.rating_sum ?? 0) / rated) * 100) / 100 : null,
    },
  }
}
