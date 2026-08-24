// Merges the site's 8 activity streams (5 Workers + static content) into one day-per-row
// timeline, keyed on YYYY-MM-DD. Scrobbles are the one stream with a real cursor, so their
// loaded window sets the floor; paging pulls more listening days and tops the rest up to
// match. Each stream keeps its own page's day-bucketing (see datetime.ts) rather than
// re-deriving one, so results can disagree slightly at timezone margins.

import { dayKey } from './datetime'
import type { Photo } from './photos'
import type { PostSummary } from './posts'
import type { Article, Book } from './reading'
import type { Film } from './watching'
import type { Activity } from './moving'
import type { Note } from './notes'
import type { CompactDay } from './listening'
import type { Concert } from './concerts'

export interface TimelineDay {
  date: string
  scrobbles: number
  /** Most-played artist that day, when the day's tracks are loaded. */
  topArtist: string | null
  articles: Article[]
  booksFinished: Book[]
  booksStarted: Book[]
  films: Film[]
  activities: Activity[]
  posts: PostSummary[]
  photos: Photo[]
  notes: Note[]
  concerts: Concert[]
}

// Photos with a real capture time only — pre-2026 Squarespace photos carry an approximate,
// year-only date (src/lib/photos.ts) that would all pile onto January 1st here.
export function datedPhotos(photos: Photo[]): Photo[] {
  return photos.filter((photo) => !photo.approx)
}

export interface TimelineSources {
  days: CompactDay[]
  articles: Article[]
  books: Book[]
  films: Film[]
  activities: Activity[]
  posts: PostSummary[]
  photos: Photo[]
  notes: Note[]
  concerts: Concert[]
  /** Oldest day to include; older streams are only partly loaded so a row would understate what happened. Null once listening is exhausted. */
  floor: string | null
}

/**
 * Fold every stream into one newest-first list of days. Days with nothing in them
 * are omitted rather than rendered empty.
 */
export function buildTimeline({
  days,
  articles,
  books,
  films,
  activities,
  posts,
  photos,
  notes,
  concerts,
  floor,
}: TimelineSources): TimelineDay[] {
  const byDate = new Map<string, TimelineDay>()

  const dayFor = (date: string): TimelineDay | null => {
    if (!date || (floor && date < floor)) return null
    let entry = byDate.get(date)
    if (!entry) {
      entry = {
        date,
        scrobbles: 0,
        topArtist: null,
        articles: [],
        booksFinished: [],
        booksStarted: [],
        films: [],
        activities: [],
        posts: [],
        photos: [],
        notes: [],
        concerts: [],
      }
      byDate.set(date, entry)
    }
    return entry
  }

  for (const day of days) {
    const entry = dayFor(day.date)
    if (!entry) continue
    entry.scrobbles = day.count
    entry.topArtist = day.topArtist
  }

  for (const article of articles) dayFor(dayKey(article.readAt))?.articles.push(article)

  for (const book of books) {
    if (book.finishedAt) dayFor(book.finishedAt.slice(0, 10))?.booksFinished.push(book)
    // A book started and finished the same day is worth saying once, as finished.
    else if (book.startedAt) dayFor(book.startedAt.slice(0, 10))?.booksStarted.push(book)
  }

  // Letterboxd logs a date, not a timestamp, so this needs no bucketing at all.
  for (const film of films) dayFor(film.watchedDate.slice(0, 10))?.films.push(film)

  // Already the athlete-local date the Worker stored, so no bucketing here either.
  for (const activity of activities) dayFor(activity.startDate)?.activities.push(activity)

  for (const post of posts) dayFor(post.date.slice(0, 10))?.posts.push(post)
  for (const photo of photos) dayFor(photo.date.slice(0, 10))?.photos.push(photo)

  // Notes are instants, bucketed in the viewer's own zone like articles — a note written
  // just before midnight Central can land on the previous day for a reader in Tokyo.
  for (const note of notes) dayFor(dayKey(note.createdAt))?.notes.push(note)

  for (const concert of concerts) dayFor(concert.date)?.concerts.push(concert)

  return [...byDate.values()]
    .filter(
      (day) =>
        day.scrobbles > 0 ||
        day.articles.length > 0 ||
        day.booksFinished.length > 0 ||
        day.booksStarted.length > 0 ||
        day.films.length > 0 ||
        day.activities.length > 0 ||
        day.posts.length > 0 ||
        day.photos.length > 0 ||
        day.notes.length > 0 ||
        day.concerts.length > 0,
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

// Days matching `monthDay` ("MM-DD") across whatever years are already loaded into `days` —
// pure, and doesn't page anything in itself (unlike /listening's dedicated fetchOnThisDay
// endpoint), so a fresh visit with little history can turn up nothing until "Load older days".
export function onThisDay(days: TimelineDay[], monthDay: string): TimelineDay[] {
  return days.filter((day) => day.date.slice(5) === monthDay)
}
