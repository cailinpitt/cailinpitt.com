import { useEffect, useState } from 'react'
import { formatNumber, keyForOffset } from './datetime'
import { buildTimeline, type TimelinePhoto, type TimelinePost, type TimelineDay } from './timeline'
import { fetchOnThisDay, fetchTimelineDays, type OnThisDay } from './listening'
import { fetchReading } from './reading'
import { fetchWatching } from './watching'
import { fetchMoving, kindIcon, summary as activitySummary } from './moving'
import { fetchNotes } from './notes'
import type { Concert } from './concerts'

// Powers the homepage Timeline preview. One unpaged fetch of every stream (plus
// listening's on-this-day), merged through the same buildTimeline() /timeline
// uses, so the two can't disagree about a day. No topUp/cursor: a handful of
// recent days needs only each stream's first page. Posts come from the
// compiled-in site index; concerts and a trimmed slice of recent photos ride in
// from the loader — every stream /timeline shows is represented here too.

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
    events.push({ stream: 'reading', icon: '📚', label: `Finished ${book.title}` })
  }
  for (const book of day.booksStarted) {
    events.push({ stream: 'reading', icon: '📚', label: `Started ${book.title}` })
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

// The most recent past year with something on today's month/day. Listening
// comes from its own cross-year endpoint; posts are fully in the site index.
// Photos/concerts aren't checked here — the homepage only has a recent slice.
function resolveOnThisDay(listening: OnThisDay | null, posts: readonly TimelinePost[]): OnThisDayEntry | null {
  const today = keyForOffset(0)
  const monthDay = today.slice(5)
  const thisYear = Number(today.slice(0, 4))

  const byYear = new Map<number, { scrobbles: number; topArtist: string | null; posts: TimelinePost[] }>()
  const entry = (year: number) => {
    let e = byYear.get(year)
    if (!e) byYear.set(year, (e = { scrobbles: 0, topArtist: null, posts: [] }))
    return e
  }

  for (const post of posts) {
    const date = post.date.slice(0, 10)
    const year = Number(date.slice(0, 4))
    if (date.slice(5) === monthDay && year && year < thisYear) entry(year).posts.push(post)
  }
  for (const year of listening?.years ?? []) {
    if (year.year >= thisYear) continue
    const e = entry(year.year)
    e.scrobbles = year.count
    e.topArtist = year.topArtist
  }

  if (byYear.size === 0) return null
  const year = Math.max(...byYear.keys())
  const e = byYear.get(year)!
  const parts = e.posts.map((post) => `published “${post.title}”`)
  if (e.scrobbles > 0) {
    parts.push(`${formatNumber(e.scrobbles)} scrobbles${e.topArtist ? ` · mostly ${e.topArtist}` : ''}`)
  }
  if (parts.length === 0) return null
  return { date: `${year}-${monthDay}`, yearsAgo: thisYear - year, summary: parts.join(' · ') }
}

export function useHomeTimeline(
  posts: readonly TimelinePost[],
  photos: readonly TimelinePhoto[],
  concerts: Concert[],
): HomeTimelineState {
  const [state, setState] = useState<HomeTimelineState>({ days: [], onThisDay: null, ready: false })

  useEffect(() => {
    const controller = new AbortController()

    // allSettled: this reads every Worker, so one being down still leaves a
    // timeline built from the rest (same reasoning as /timeline itself).
    Promise.allSettled([
      fetchTimelineDays(controller.signal),
      fetchReading(controller.signal),
      fetchWatching(controller.signal),
      fetchMoving(controller.signal),
      fetchNotes(controller.signal),
      fetchOnThisDay(controller.signal),
    ]).then(([listening, reading, watching, moving, notes, otd]) => {
      if (controller.signal.aborted) return
      const value = <T,>(r: PromiseSettledResult<T>): T | null =>
        r.status === 'fulfilled' ? r.value : null

      const l = value(listening)
      const r = value(reading)
      const w = value(watching)
      const m = value(moving)
      const n = value(notes)

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

      setState({ days, onThisDay: resolveOnThisDay(value(otd), posts), ready: true })
    })

    return () => controller.abort()
  }, [posts, photos, concerts])

  return state
}
