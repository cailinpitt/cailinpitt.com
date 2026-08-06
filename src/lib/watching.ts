// Client for the watching API (the Cloudflare Worker in /worker-watching).
// Like /reading and /listening, the page is prerendered as a static shell and
// fetches this in the browser.
//
// These interfaces mirror the Worker's by hand — the two aren't a shared
// package, so a change on one side has to be made on the other.

import { imageUrl } from './images'

const API_BASE = import.meta.env.VITE_WATCHING_API ?? 'https://watching.cailinpitt.com'

export interface Film {
  id: string
  title: string
  year: number | null
  slug: string | null
  /** YYYY-MM-DD — Letterboxd logs a date, not a timestamp. */
  watchedDate: string
  rewatch: boolean
  /** Out of 5, in half stars. Null when unrated. */
  rating: number | null
  liked: boolean
  /** `/images/watching/…` on R2, or null if the poster isn't mirrored yet. */
  poster: string | null
}

export interface FilmPage {
  films: Film[]
  /** Opaque; pass straight back to fetchOlderFilms. Null means no more. */
  nextCursor: string | null
}

export interface WatchingBundle extends FilmPage {
  updatedAt: number
  counts: {
    films: number
    filmsThisYear: number
    rewatches: number
    meanRating: number | null
  }
}

/** Lightweight payload for the terminal (see /now.json). */
export interface WatchingNow {
  lastFilm: Film | null
  updatedAt: number
}

export async function fetchWatching(signal?: AbortSignal): Promise<WatchingBundle> {
  const res = await fetch(`${API_BASE}/watching.json`, { signal })
  if (!res.ok) throw new Error(`Watching API ${res.status}`)
  return res.json() as Promise<WatchingBundle>
}

export async function fetchWatchingNow(signal?: AbortSignal): Promise<WatchingNow> {
  const res = await fetch(`${API_BASE}/now.json`, { signal })
  if (!res.ok) throw new Error(`Watching API ${res.status}`)
  return res.json() as Promise<WatchingNow>
}

export async function fetchOlderFilms(
  cursor: string,
  limit = 24,
  signal?: AbortSignal,
): Promise<FilmPage> {
  const res = await fetch(`${API_BASE}/films?cursor=${encodeURIComponent(cursor)}&limit=${limit}`, {
    signal,
  })
  if (!res.ok) throw new Error(`Watching API ${res.status}`)
  return res.json() as Promise<FilmPage>
}

// ---- presentation helpers ------------------------------------------------

/** Posters are R2 paths; everything else passes through. */
export const watchingImage = (src: string | null): string | null =>
  imageUrl(src ?? undefined) ?? null

/**
 * The film's public page — deliberately not the diary entry.
 *
 * The feed's own permalink is `letterboxd.com/<member>/film/<slug>/`, which
 * would put the account on every card and lead anyone who clicks straight to
 * the profile. `/film/<slug>/` is the same film for everyone.
 */
export const letterboxdUrl = (film: Film): string | null =>
  film.slug ? `https://letterboxd.com/film/${film.slug}/` : null

/**
 * "★★★½" from a 0–5 rating.
 *
 * Half stars are rendered rather than rounded up, unlike the book shelf: on
 * Letterboxd the half *is* the scale — a 3½ and a 4 mean different things, and
 * flattening them would throw away most of what a rating says.
 */
export function stars(rating: number | null): string | null {
  if (rating == null || rating <= 0) return null
  const full = Math.floor(rating)
  return '★'.repeat(full) + (rating - full >= 0.5 ? '½' : '')
}

/**
 * Split films into year sections, newest first. The API already returns them in
 * watched-date order, so this only has to walk the list once and start a new
 * group when the year changes.
 */
export function filmsByYear(films: Film[]): { year: string; films: Film[] }[] {
  const years: { year: string; films: Film[] }[] = []
  for (const film of films) {
    const year = film.watchedDate.slice(0, 4)
    const last = years[years.length - 1]
    if (last?.year === year) last.films.push(film)
    else years.push({ year, films: [film] })
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

export function formatWatchedDate(date: string | null): string | null {
  if (!date) return null
  // Parse at noon UTC so the formatter can't push it onto the adjacent day.
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : dateFmt.format(parsed)
}
