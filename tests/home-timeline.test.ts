import { describe, expect, it } from 'vitest'
import { dayEvents } from '../src/lib/homeTimeline'
import type { TimelineDay } from '../src/lib/timeline'

// dayEvents is the per-day line list the homepage preview renders.

const base: TimelineDay = {
  date: '2026-09-06',
  scrobbles: 0,
  topArtist: null,
  articles: [],
  links: [],
  booksFinished: [],
  booksStarted: [],
  films: [],
  activities: [],
  posts: [],
  photos: [],
  notes: [],
  concerts: [],
}

describe('dayEvents', () => {
  it('leads with discrete moments, then the count streams, each tagged with its stream', () => {
    const day: TimelineDay = {
      ...base,
      scrobbles: 42,
      topArtist: 'Interpol',
      posts: [{ path: '/blog/2026/9/6/x', title: 'A Post', date: '2026-09-06' }],
      films: [{ title: 'Dune' } as TimelineDay['films'][number]],
      articles: [{} as TimelineDay['articles'][number]],
      photos: [{} as TimelineDay['photos'][number], {} as TimelineDay['photos'][number]],
    }
    expect(dayEvents(day).map((e) => `${e.stream}:${e.label}`)).toEqual([
      'writing:Published “A Post”',
      'photos:2 photos posted',
      'watching:Watched Dune',
      'listening:42 scrobbles · Interpol',
      'reading:1 article saved',
    ])
  })

  it('lists saved links after saved articles, each with its own glyph', () => {
    const day: TimelineDay = {
      ...base,
      articles: [{} as TimelineDay['articles'][number]],
      links: [{} as TimelineDay['links'][number], {} as TimelineDay['links'][number]],
    }
    expect(dayEvents(day).map((e) => `${e.icon} ${e.stream}:${e.label}`)).toEqual([
      '📄 reading:1 article saved',
      '🔗 reading:2 links saved',
    ])
  })

  it('singularises one of a thing', () => {
    const events = dayEvents({ ...base, scrobbles: 1, notes: [{} as TimelineDay['notes'][number]] })
    expect(events.map((e) => e.label)).toEqual(['1 scrobble', '1 note'])
  })

  it('is empty for a day with nothing in it', () => {
    expect(dayEvents(base)).toEqual([])
  })
})
