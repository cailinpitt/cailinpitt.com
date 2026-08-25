import { describe, expect, it } from 'vitest'
import { currentStreak, onThisDay, type TimelineDay } from '../src/lib/timeline'
import { addDays, keyForOffset } from '../src/lib/datetime'

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

describe('currentStreak', () => {
  const today = keyForOffset(0)

  it('counts consecutive days ending today', () => {
    const days = [today, addDays(today, -1), addDays(today, -2)].map(day)
    expect(currentStreak(days)).toBe(3)
  })

  it('still counts when the newest day is yesterday', () => {
    const yesterday = addDays(today, -1)
    const days = [yesterday, addDays(yesterday, -1)].map(day)
    expect(currentStreak(days)).toBe(2)
  })

  it('stops at a gap', () => {
    const days = [today, addDays(today, -1), addDays(today, -3)].map(day)
    expect(currentStreak(days)).toBe(2)
  })

  it('is 0 when the newest day is stale', () => {
    expect(currentStreak([day(addDays(today, -5))])).toBe(0)
  })

  it('is 0 with no days', () => {
    expect(currentStreak([])).toBe(0)
  })
})
