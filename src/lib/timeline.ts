// Merging the site's eight activity streams into one day-per-row timeline (/timeline).
//
// The streams live in five places and none of them knows about the others:
// scrobbles come from the listening Worker, articles and books from the reading
// Worker, films from the watching Worker, rides and lifts from the moving
// Worker, notes from the notes Worker, and posts and photos are static
// content compiled into the build. So the merge happens here, in the browser,
// keyed on a YYYY-MM-DD day.
//
// ## What decides how far back the timeline goes
//
// Scrobbles are by far the densest stream and the only one with a real cursor
// worth paging, so they set the floor: the timeline shows every day from today
// back to the oldest listening day loaded, and the other streams are filtered
// into that window. Paging pulls another block of listening days, drops the
// floor, and tops the other streams up to match. Once listening runs out there
// is no floor left and everything remaining is shown.
//
// A day with no scrobbles still gets a row if something else happened on it —
// the listening days seed the map, they don't limit it.
//
// ## Day bucketing is inherited, not re-derived
//
// Each stream is bucketed the way its own page already buckets it (see the notes
// in datetime.ts): the Worker groups scrobbles into US Central days, articles
// bucket by the viewer's local zone, and activities/films/books/posts/photos carry date
// strings that are used as written — a film's watched date is the day Cailin
// logged it against, which is the only day it can honestly sit on. Those rules disagree at the margins for a visitor far
// from US Central, which is a pre-existing property of the data rather than
// something this page can fix — recomputing it would need per-scrobble
// timestamps the aggregates don't carry.

import { dayKey } from './datetime'
import type { Photo } from './photos'
import type { PostSummary } from './posts'
import type { Article, Book } from './reading'
import type { Film } from './watching'
import type { Activity } from './moving'
import type { Note } from './notes'
import type { CompactDay } from './listening'

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
}

/**
 * Photos that can be placed on a timeline at all — the ones whose date is a real
 * capture time. Everything before 2026 came out of Squarespace EXIF-stripped and
 * carries an approximate date good only to the year (see src/lib/photos.ts), and
 * a day-per-row page has nowhere to put that: they'd all pile onto January 1st.
 */
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
  /**
   * Oldest day to include, YYYY-MM-DD. Days older than this are dropped, because
   * the streams that reach past it are only partly loaded and a row built from
   * them would understate what actually happened. Null once listening is
   * exhausted, which means "show everything left".
   */
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

  // Notes are instants, so they bucket in the viewer's own zone the way articles
  // do — the same inherited-bucketing property described above, and the same
  // consequence: a note written just before midnight in Central can land on the
  // previous day for a reader in Tokyo.
  for (const note of notes) dayFor(dayKey(note.createdAt))?.notes.push(note)

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
        day.notes.length > 0,
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}
