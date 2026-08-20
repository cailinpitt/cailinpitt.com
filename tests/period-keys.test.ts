import { describe, expect, it } from 'vitest'
import {
  allPeriods,
  convertKey,
  currentKey,
  labelFor,
  parseRoute,
  step,
  urlFor,
  weekKeyOf,
  weekStartOf,
  withinArchive,
  FIRST_LISTENING_DAY,
} from '../src/lib/periodKeys'
import { parsePeriod, periodContaining, enumeratePeriods } from '../worker-listening/src/periods'

// Period keys are URLs, so must be stable forever. Awkward cases are at the year boundary, where ISO weeks can belong to a different year than their Monday.

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)

// US Central, the fixed offset the Worker buckets local days with.
const OFFSET = -18000

describe('ISO week keys', () => {
  it('assigns a week to the year containing its Thursday', () => {
    // 2021-01-01 was a Friday, so that week's Thursday was 2020-12-31 → 2020-W53.
    expect(weekKeyOf(utc('2021-01-01'))).toBe('2020-W53')
    // 2020-12-31 is in the same week.
    expect(weekKeyOf(utc('2020-12-31'))).toBe('2020-W53')
    // 2021-01-04 was the Monday of 2021-W01.
    expect(weekKeyOf(utc('2021-01-04'))).toBe('2021-W01')
  })

  it('treats Jan 4 as week 1 in every year', () => {
    for (let year = 2019; year <= 2030; year++) {
      expect(weekKeyOf(utc(`${year}-01-04`))).toBe(`${year}-W01`)
    }
  })

  it('round-trips key → Monday → key', () => {
    for (const key of ['2021-W01', '2020-W53', '2024-W09', '2026-W32', '2026-W01']) {
      const start = weekStartOf(key)
      expect(start, key).not.toBeNull()
      // Every ISO week starts on a Monday.
      expect(start!.getUTCDay()).toBe(1)
      expect(weekKeyOf(start!)).toBe(key)
    }
  })

  it('rejects a week 53 that does not exist', () => {
    // 2026 has 53 ISO weeks only if it starts or ends on the right weekday; 2021
    // does not, so 2021-W53 must not silently roll into 2022.
    expect(weekStartOf('2021-W53')).toBeNull()
    expect(weekStartOf('2021-W54')).toBeNull()
    expect(weekStartOf('nonsense')).toBeNull()
  })
})

describe('route parsing', () => {
  it('distinguishes a month from a week by the W', () => {
    expect(parseRoute('2026', '08')).toEqual({ kind: 'm', key: '2026-08' })
    expect(parseRoute('2026', 'W32')).toEqual({ kind: 'w', key: '2026-W32' })
    expect(parseRoute('2026')).toEqual({ kind: 'y', key: '2026' })
    expect(parseRoute('all')).toEqual({ kind: 'all', key: 'all' })
  })

  it('rejects malformed routes rather than guessing', () => {
    expect(parseRoute(undefined)).toBeNull()
    expect(parseRoute('26', '08')).toBeNull()
    expect(parseRoute('2026', '13')).toBeNull()
    expect(parseRoute('2026', '00')).toBeNull()
    expect(parseRoute('2026', 'W99')).toBeNull()
    expect(parseRoute('2026', 'august')).toBeNull()
  })

  it('round-trips through urlFor', () => {
    for (const [kind, key] of [
      ['y', '2026'],
      ['m', '2026-08'],
      ['w', '2026-W32'],
      ['all', 'all'],
    ] as const) {
      const url = urlFor(kind, key)
      const [, , a, b] = url.split('/')
      expect(parseRoute(a, b), url).toEqual({ kind, key })
    }
  })
})

describe('stepping between periods', () => {
  const now = utc('2026-08-06')

  it('walks years, months and weeks', () => {
    expect(step('y', '2025', -1, now)).toBe('2024')
    expect(step('m', '2026-03', -1, now)).toBe('2026-02')
    expect(step('m', '2026-01', -1, now)).toBe('2025-12')
    expect(step('w', '2026-W02', -1, now)).toBe('2026-W01')
  })

  it('crosses the year boundary by week correctly', () => {
    // The previous ISO year's last week is 52 or 53 depending on the year, so derive it rather than hard-code.
    const from = weekStartOf('2023-W01')!
    const back = step('w', '2023-W01', -1, now)
    expect(back).toBe('2022-W52')
    const to = weekStartOf(back!)!
    expect(from.getTime() - to.getTime()).toBe(7 * 86_400_000)
  })

  it('refuses to step outside the archive even across a year boundary', () => {
    // 2020-W53 exists as a week but predates the first scrobble.
    expect(weekStartOf('2020-W53')).not.toBeNull()
    expect(step('w', '2021-W01', -1, now)).toBeNull()
  })

  it('stops at the ends of the archive', () => {
    expect(step('y', '2026', 1, now)).toBeNull()
    expect(step('y', String(new Date(FIRST_LISTENING_DAY).getUTCFullYear()), -1, now)).toBeNull()
    expect(step('m', '2021-03', -1, now)).toBeNull()
    expect(step('all', 'all', 1, now)).toBeNull()
  })
})

describe('granularity switching', () => {
  it('keeps your place instead of jumping to today', () => {
    expect(convertKey('w', '2023-W10', 'm')).toBe('2023-03')
    expect(convertKey('m', '2023-03', 'y')).toBe('2023')
    expect(convertKey('y', '2023', 'm')).toBe('2023-01')
    expect(convertKey('m', '2023-03', 'all')).toBe('all')
  })

  it('falls back to the current period when the target is outside the archive', () => {
    // 2021-01 predates the first scrobble, so it can't be navigated to.
    expect(withinArchive('m', '2021-01')).toBe(false)
    expect(convertKey('y', '2021', 'm')).toBe(currentKey('m'))
  })
})

describe('labels', () => {
  it('reads naturally at every granularity', () => {
    expect(labelFor('y', '2026')).toBe('2026')
    expect(labelFor('m', '2026-08')).toBe('August 2026')
    expect(labelFor('all', 'all')).toBe('All time')
    // 2026-W32's Monday is 2026-08-03.
    expect(labelFor('w', '2026-W32')).toBe('Week of Aug 3, 2026')
  })
})

describe('prerendered path list', () => {
  const periods = allPeriods(utc('2026-08-06'))

  it('covers the archive without duplicates', () => {
    const urls = periods.map((p) => urlFor(p.kind, p.key))
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls).toContain('/listening/all')
    expect(urls).toContain('/listening/2021')
    expect(urls).toContain('/listening/2026/08')
  })

  it('starts no earlier than the first scrobble', () => {
    const weeks = periods.filter((p) => p.kind === 'w')
    const earliest = weeks.map((p) => p.key).sort()[0]
    // The archive opens mid-week, so the first week is the one containing it.
    expect(earliest).toBe(weekKeyOf(utc(FIRST_LISTENING_DAY)))
  })
})

// The client and Worker do this arithmetic independently; if they disagree, pages resolve to the wrong data.
describe('client and Worker agree', () => {
  it('produces the same keys for the same instants', () => {
    for (const iso of ['2021-03-01', '2021-01-01', '2024-02-29', '2026-08-06', '2020-12-31']) {
      const date = utc(iso)
      // Compare at local noon, so the fixed offset can't shift the calendar day.
      const uts = Math.floor(date.getTime() / 1000) + 12 * 3600 - OFFSET
      expect(periodContaining('w', uts, OFFSET).key, iso).toBe(weekKeyOf(date))
      expect(periodContaining('m', uts, OFFSET).key, iso).toBe(
        `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
      )
    }
  })

  it('gives every key a range that contains its own midpoint', () => {
    for (const [kind, key] of [
      ['y', '2024'],
      ['m', '2024-02'],
      ['w', '2026-W32'],
    ] as const) {
      const period = parsePeriod(kind, key, OFFSET)
      expect(period, key).not.toBeNull()
      const mid = Math.floor((period!.start + period!.end) / 2)
      expect(periodContaining(kind, mid, OFFSET).key).toBe(key)
    }
  })

  it('makes consecutive periods share a boundary with no gap or overlap', () => {
    const weeks = enumeratePeriods('w', utc('2026-01-01').getTime() / 1000, utc('2026-08-06').getTime() / 1000, OFFSET)
    expect(weeks.length).toBeGreaterThan(20)
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i].start).toBe(weeks[i - 1].end)
    }
  })

  it('rejects the same malformed keys the client does', () => {
    expect(parsePeriod('w', '2021-W53', OFFSET)).toBeNull()
    expect(parsePeriod('m', '2026-13', OFFSET)).toBeNull()
    expect(parsePeriod('y', 'abcd', OFFSET)).toBeNull()
    expect(parsePeriod('nope', '2026', OFFSET)).toBeNull()
  })
})
