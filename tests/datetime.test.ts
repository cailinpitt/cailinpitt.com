import { describe, expect, it } from 'vitest'
import { addDays } from '../src/lib/datetime'

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
