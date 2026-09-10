import { useEffect, useState } from 'react'
import { formatNumber, keyForOffset } from './datetime'
import { buildTimeline, type TimelinePhoto, type TimelinePost, type TimelineDay } from './timeline'
import { fetchOnThisDay, fetchTimelineDays, type OnThisDay } from './listening'
import { fetchArticlesOnDate, fetchBooksOnDate, fetchLinksOnDate, fetchReading } from './reading'
import { fetchFilmsOnDate, fetchWatching } from './watching'
import {
  fetchActivitiesOnDate,
  fetchMoving,
  kindIcon,
  summary as activitySummary,
} from './moving'
import { fetchNotes, fetchNotesOnDate } from './notes'
import type { Concert } from './concerts'

// Powers the homepage Timeline preview. One unpaged fetch of every stream (plus
// listening's on-this-day), merged through the same buildTimeline() /timeline
// uses, so the two can't disagree about a day. No topUp/cursor: a handful of
// recent days needs only each stream's first page. Posts come from the
// compiled-in site index; concerts and a trimmed slice of recent photos ride in
// from the loader — every stream /timeline shows is represented here too.
//
// The "N years ago today" line then does a second batch: it picks the year from
// listening + posts and pulls that one day from every stream's day-scoped
// endpoint (the same ones /timeline/:date reads), so it summarizes the whole day
// — rides, lifts, films, books — not just the music.

/** Recent days shown before "Explore the full timeline". */
const HOME_DAYS = 5

export interface OnThisDayEntry {
  date: string
  yearsAgo: number
  summary: string
}

export interface HomeTimelineState {
  days: TimelineDay[]
  onThisDay: OnThisDayEntry | null
  ready: boolean
}

/** One line of a day's row in the preview. `stream` matches /timeline's data-stream values so the colour accents line up. */
export interface DayEvent {
  stream: 'listening' | 'reading' | 'watching' | 'concerts' | 'moving' | 'writing' | 'notes' | 'photos'
  icon: string
  label: string
}

const plural = (n: number, one: string) => `${formatNumber(n)} ${n === 1 ? one : `${one}s`}`

// Discrete moments (a post, a show, a film, a roll of photos) lead; the
// count-ish streams (scrobbles, articles, notes) follow — a highlight order for
// a teaser, not the chronological one /timeline itself renders. Every stream
// /timeline has is represented.
export function dayEvents(day: TimelineDay): DayEvent[] {
  const events: DayEvent[] = []
  for (const post of day.posts) {
    events.push({ stream: 'writing', icon: '✍️', label: `Published “${post.title}”` })
  }
  for (const concert of day.concerts) {
    events.push({ stream: 'concerts', icon: '🎤', label: `Saw ${concert.artists.join(' / ')}` })
  }
  if (day.photos.length) {
    events.push({ stream: 'photos', icon: '📸', label: `${plural(day.photos.length, 'photo')} posted` })
  }
  for (const film of day.films) events.push({ stream: 'watching', icon: '🎬', label: `Watched ${film.title}` })
  for (const book of day.booksFinished) {
    events.push({ stream: 'reading', icon: '📚', label: `Finished reading ${book.title}` })
  }
  for (const book of day.booksStarted) {
    events.push({ stream: 'reading', icon: '📚', label: `Started reading ${book.title}` })
  }
  for (const activity of day.activities) {
    events.push({ stream: 'moving', icon: kindIcon(activity.kind), label: activitySummary(activity) })
  }
  if (day.scrobbles > 0) {
    events.push({
      stream: 'listening',
      icon: '🎧',
      label: plural(day.scrobbles, 'scrobble') + (day.topArtist ? ` · ${day.topArtist}` : ''),
    })
  }
  if (day.articles.length) {
    events.push({ stream: 'reading', icon: '📰', label: `${plural(day.articles.length, 'article')} saved` })
  }
  if (day.links.length) {
    events.push({ stream: 'reading', icon: '🔗', label: `${plural(day.links.length, 'link')} saved` })
  }
  if (day.notes.length) events.push({ stream: 'notes', icon: '💬', label: plural(day.notes.length, 'note') })
  return events
}

/** Things named in the "N years ago today" line before it trails off into
 *  "+N more" — matching how the today/yesterday rows cap their event list. */
const MAX_OTD_PARTS = 3

// `new Date('YYYY-MM-DD')` parses as UTC midnight; go through the numeric
// constructor for the viewer's own local day, the same range /timeline/:date
// asks the day-scoped endpoints for.
function localDayRange(date: string): [number, number] {
  const [y, m, d] = date.split('-').map(Number)
  const start = new Date(y, m - 1, d).getTime() / 1000
  return [start, start + 86_400]
}

const lowerFirst = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s)

const settled = <T,>(r: PromiseSettledResult<T>): T | null =>
  r.status === 'fulfilled' ? r.value : null

/**
 * Which past year the "on this day" line should cover: the most recent one with
 * a post or a scrobble on today's month/day. Listening comes from its own
 * cross-year endpoint; posts are fully in the compiled-in site index.
 */
function pickOnThisDayYear(
  listening: OnThisDay | null,
  posts: readonly TimelinePost[],
): { date: string; yearsAgo: number; scrobbles: number; topArtist: string | null } | null {
  const today = keyForOffset(0)
  const monthDay = today.slice(5)
  const thisYear = Number(today.slice(0, 4))

  const years = new Set<number>()
  const byYear = new Map<number, { count: number; topArtist: string | null }>()

  for (const post of posts) {
    const date = post.date.slice(0, 10)
    const year = Number(date.slice(0, 4))
    if (date.slice(5) === monthDay && year && year < thisYear) years.add(year)
  }
  for (const y of listening?.years ?? []) {
    if (y.year >= thisYear) continue
    years.add(y.year)
    byYear.set(y.year, { count: y.count, topArtist: y.topArtist })
  }

  if (years.size === 0) return null
  const year = Math.max(...years)
  const l = byYear.get(year)
  return {
    date: `${year}-${monthDay}`,
    yearsAgo: thisYear - year,
    scrobbles: l?.count ?? 0,
    topArtist: l?.topArtist ?? null,
  }
}

/** Fold one day into a single line — discrete things first, count-ish streams after. */
export function summarizeOnThisDay(day: TimelineDay): string {
  const parts: string[] = []
  for (const post of day.posts) parts.push(`published “${post.title}”`)
  for (const concert of day.concerts) parts.push(`saw ${concert.artists.join(' / ')}`)
  for (const film of day.films) parts.push(`watched ${film.title}`)
  for (const book of day.booksFinished) parts.push(`finished reading ${book.title}`)
  for (const book of day.booksStarted) parts.push(`started reading ${book.title}`)
  for (const activity of day.activities) parts.push(lowerFirst(activitySummary(activity)))
  if (day.scrobbles > 0) {
    parts.push(
      `${formatNumber(day.scrobbles)} scrobbles${day.topArtist ? ` · mostly ${day.topArtist}` : ''}`,
    )
  }
  if (day.articles.length) parts.push(`saved ${plural(day.articles.length, 'article')}`)
  if (day.links.length) parts.push(`saved ${plural(day.links.length, 'link')}`)
  if (day.notes.length) parts.push(plural(day.notes.length, 'note'))
  if (day.photos.length) parts.push(plural(day.photos.length, 'photo'))

  const shown = parts.slice(0, MAX_OTD_PARTS)
  const more = parts.length - shown.length
  if (more > 0) shown.push(`+${more} more`)
  return shown.join(' · ')
}

/**
 * The "N years ago today" line: pick the year (above), then pull that exact day
 * from every stream's day-scoped endpoint — the same ones /timeline/:date reads
 * — and fold it into one sentence. Null when no past year has anything.
 */
async function resolveOnThisDay(
  listening: OnThisDay | null,
  posts: readonly TimelinePost[],
  photos: readonly TimelinePhoto[],
  concerts: readonly Concert[],
  signal: AbortSignal,
): Promise<OnThisDayEntry | null> {
  const target = pickOnThisDayYear(listening, posts)
  if (!target) return null

  const { date, yearsAgo, scrobbles, topArtist } = target
  const [from, to] = localDayRange(date)

  const [books, articles, links, films, activities, notes] = await Promise.allSettled([
    fetchBooksOnDate(date, signal),
    fetchArticlesOnDate(from, to, signal),
    fetchLinksOnDate(from, to, signal),
    fetchFilmsOnDate(date, signal),
    fetchActivitiesOnDate(date, signal),
    fetchNotesOnDate(from, to, signal),
  ])
  if (signal.aborted) return null

  const [day] = buildTimeline({
    days: [{ date, count: scrobbles, topArtist }],
    articles: settled(articles) ?? [],
    links: settled(links) ?? [],
    books: settled(books) ?? [],
    films: settled(films) ?? [],
    activities: settled(activities) ?? [],
    posts: posts.filter((p) => p.date.slice(0, 10) === date),
    photos: photos.filter((p) => p.date.slice(0, 10) === date),
    notes: settled(notes) ?? [],
    concerts: concerts.filter((c) => c.date === date),
    floor: null,
  })

  const summary = day ? summarizeOnThisDay(day) : ''
  return summary ? { date, yearsAgo, summary } : null
}

export function useHomeTimeline(
  posts: readonly TimelinePost[],
  photos: readonly TimelinePhoto[],
  concerts: Concert[],
): HomeTimelineState {
  const [state, setState] = useState<HomeTimelineState>({ days: [], onThisDay: null, ready: false })

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller

    // allSettled: this reads every Worker, so one being down still leaves a
    // timeline built from the rest (same reasoning as /timeline itself).
    Promise.allSettled([
      fetchTimelineDays(signal),
      fetchReading(signal),
      fetchWatching(signal),
      fetchMoving(signal),
      fetchNotes(signal),
      fetchOnThisDay(signal),
    ]).then(async ([listening, reading, watching, moving, notes, otd]) => {
      if (signal.aborted) return

      const l = settled(listening)
      const r = settled(reading)
      const w = settled(watching)
      const m = settled(moving)
      const n = settled(notes)

      const days = buildTimeline({
        days: l?.days ?? [],
        articles: r?.articles ?? [],
        links: r?.links ?? [],
        books: r ? [...r.currentlyReading, ...r.finishedBooks] : [],
        films: w?.films ?? [],
        activities: m?.activities ?? [],
        posts,
        photos,
        notes: n?.notes ?? [],
        concerts,
        floor: null,
      }).slice(0, HOME_DAYS)

      // The "N years ago today" line needs a second round of day-scoped fetches
      // (small, edge-cached, parallel). Resolve it before the one setState so the
      // section doesn't lay itself out twice — it's a bonus, so a failure just
      // leaves it off.
      const onThisDay = await resolveOnThisDay(
        settled(otd),
        posts,
        photos,
        concerts,
        signal,
      ).catch(() => null)
      if (signal.aborted) return

      setState({ days, onThisDay, ready: true })
    })

    return () => controller.abort()
  }, [posts, photos, concerts])

  return state
}
