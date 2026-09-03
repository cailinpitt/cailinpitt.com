import { describe, expect, it } from 'vitest'
import { addDays, formatDayStamp, keyForOffset } from '../src/lib/datetime'

describe('addDays', () => {
  it('steps forward and back within a month', () => {
    expect(addDays('2026-08-15', 1)).toBe('2026-08-16')
    expect(addDays('2026-08-15', -1)).toBe('2026-08-14')
  })

  it('rolls over a month boundary', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31')
  })

  it('rolls over a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('formatDayStamp', () => {
  it('reads today and yesterday relative', () => {
    expect(formatDayStamp(keyForOffset(0))).toBe('Today')
    expect(formatDayStamp(keyForOffset(-1))).toBe('Yesterday')
  })

  it('falls back to a dated stamp with the year', () => {
    expect(formatDayStamp('2024-06-09')).toBe('June 9, 2024')
  })

  it('accepts a longer ISO string, using only the date', () => {
    expect(formatDayStamp('2024-06-09T18:30:00Z')).toBe('June 9, 2024')
  })

  it('is null for empty or unparseable input', () => {
    expect(formatDayStamp(null)).toBeNull()
    expect(formatDayStamp('')).toBeNull()
    expect(formatDayStamp('not-a-date')).toBeNull()
  })
})
