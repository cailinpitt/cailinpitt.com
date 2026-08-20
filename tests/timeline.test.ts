import { describe, expect, it } from 'vitest'
import { onThisDay, type TimelineDay } from '../src/lib/timeline'

// Pins that onThisDay filters on month+day alone, ignoring the year (see lib/timeline.ts).

const day = (date: string): TimelineDay => ({
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
