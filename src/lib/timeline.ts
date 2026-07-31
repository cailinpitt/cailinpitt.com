// Merging the site's five activity streams into one day-per-row timeline (/log).
//
// The streams live in three places and none of them knows about the others:
// scrobbles come from the listening Worker, articles and books from the reading
// Worker, posts and photos are static content compiled into the build. So the
// merge happens here, in the browser, keyed on a YYYY-MM-DD day.
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
// bucket by the viewer's local zone, and books/posts/photos carry date strings
// that are used as written. Those rules disagree at the margins for a visitor far
// from US Central, which is a pre-existing property of the data rather than
// something this page can fix — recomputing it would need per-scrobble
// timestamps the aggregates don't carry.

import { dayKey } from './datetime'
import type { Gallery } from './galleries'
import type { PostSummary } from './posts'
import type { Article, Book } from './reading'
import type { DayLog } from './listening'

/** A photo placed in time by the capture date recorded in its EXIF. */
export interface DatedPhoto {
  /** YYYY-MM-DD, from the capture wall clock. */
  date: string
  galleryTitle: string
  galleryPath: string
  /** 1-based position in its gallery, for the lightbox deep link (?photo=N). */
  index: number
  src: string
  thumb?: string
  alt: string
}

export interface TimelineDay {
  date: string
  scrobbles: number
  /** Most-played artist that day, when the day's tracks are loaded. */
  topArtist: string | null
  articles: Article[]
  booksFinished: Book[]
  booksStarted: Book[]
  posts: PostSummary[]
  photos: DatedPhoto[]
}

/**
 * Photos that can be placed on a timeline at all — only the galleries built from
 * originals/ carry a capture date. The pre-2026 galleries came out of Squarespace
 * EXIF-stripped, so they simply never appear here.
 */
export function datedPhotos(galleries: Gallery[]): DatedPhoto[] {
  const out: DatedPhoto[] = []
  for (const gallery of galleries) {
    // Alias galleries (e.g. /past-work → /2022) would double every photo.
    if (gallery.canonicalPath) continue
    for (const [i, image] of gallery.images.entries()) {
      const shot = image.exif?.shot
      if (!shot) continue
      out.push({
        date: shot.slice(0, 10),
        galleryTitle: gallery.title,
        galleryPath: gallery.path,
        index: i + 1,
        src: image.src,
        thumb: image.thumb,
        alt: image.alt,
      })
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** The most-played artist in a day's tracks, or null if the day carries none. */
function topArtist(day: DayLog): string | null {
  const counts = new Map<string, number>()
  for (const track of day.tracks) counts.set(track.artist, (counts.get(track.artist) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [artist, count] of counts) {
    if (count > bestCount) {
      best = artist
      bestCount = count
    }
  }
  return best
}

export interface TimelineSources {
  days: DayLog[]
  articles: Article[]
  books: Book[]
  posts: PostSummary[]
  photos: DatedPhoto[]
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
  posts,
  photos,
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
        posts: [],
        photos: [],
      }
      byDate.set(date, entry)
    }
    return entry
  }

  for (const day of days) {
    const entry = dayFor(day.date)
    if (!entry) continue
    entry.scrobbles = day.count
    entry.topArtist = topArtist(day)
  }

  for (const article of articles) dayFor(dayKey(article.readAt))?.articles.push(article)

  for (const book of books) {
    if (book.finishedAt) dayFor(book.finishedAt.slice(0, 10))?.booksFinished.push(book)
    // A book started and finished the same day is worth saying once, as finished.
    else if (book.startedAt) dayFor(book.startedAt.slice(0, 10))?.booksStarted.push(book)
  }

  for (const post of posts) dayFor(post.date.slice(0, 10))?.posts.push(post)
  for (const photo of photos) dayFor(photo.date)?.photos.push(photo)

  return [...byDate.values()]
    .filter(
      (day) =>
        day.scrobbles > 0 ||
        day.articles.length > 0 ||
        day.booksFinished.length > 0 ||
        day.booksStarted.length > 0 ||
        day.posts.length > 0 ||
        day.photos.length > 0,
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}
