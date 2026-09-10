import { describe, expect, it } from 'vitest'
import { buildTimeline, onThisDay, type TimelineDay } from '../src/lib/timeline'
import type { Link } from '../src/lib/reading'

const EMPTY_SOURCES = {
  days: [],
  articles: [],
  links: [],
  books: [],
  films: [],
  activities: [],
  posts: [],
  photos: [],
  notes: [],
  concerts: [],
  floor: null,
}

// Pins that onThisDay filters on month+day alone, ignoring the year (see lib/timeline.ts).

const day = (date: string): TimelineDay => ({
  date,
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
})

describe('onThisDay', () => {
  it('matches the same month and day across years', () => {
    const days = [day('2026-08-11'), day('2025-08-11'), day('2024-03-02'), day('2019-08-11')]
    expect(onThisDay(days, '08-11').map((d) => d.date)).toEqual([
      '2026-08-11',
      '2025-08-11',
      '2019-08-11',
    ])
  })

  it('finds nothing when no year has that date loaded', () => {
    const days = [day('2026-01-01'), day('2026-06-15')]
    expect(onThisDay(days, '08-11')).toEqual([])
  })

  it('does not match a different day in the same month', () => {
    expect(onThisDay([day('2026-08-12')], '08-11')).toEqual([])
  })
})

describe('buildTimeline links', () => {
  const link = (id: string, savedAt: number): Link => ({
    id,
    url: `https://example.com/${id}`,
    title: id,
    site: 'example.com',
    excerpt: null,
    note: null,
    savedAt,
  })

  it('buckets a saved link onto its local day and makes the day non-empty', () => {
    // 2026-09-06T12:00:00Z — safely mid-day in any common zone.
    const at = Math.floor(Date.parse('2026-09-06T12:00:00Z') / 1000)
    const [today] = buildTimeline({ ...EMPTY_SOURCES, links: [link('a', at)] })
    expect(today.links.map((l) => l.id)).toEqual(['a'])
    expect(today.date.slice(0, 7)).toBe('2026-09')
  })

  it('drops links older than the floor', () => {
    const at = Math.floor(Date.parse('2020-01-01T12:00:00Z') / 1000)
    expect(buildTimeline({ ...EMPTY_SOURCES, links: [link('old', at)], floor: '2025-01-01' })).toEqual(
      [],
    )
  })
})
