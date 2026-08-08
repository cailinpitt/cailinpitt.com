import { describe, expect, it } from 'vitest'
import { heartRate, type Activity } from '../src/lib/moving'

// Heart rate is the one activity field that is genuinely absent most of the
// time: it exists only when a monitor was worn, and every row predating the
// column is null. The rules below are what keep "no reading" from rendering as
// a reading of zero.

const activity = (over: Partial<Activity> = {}): Activity => ({
  id: '1',
  sportType: 'Ride',
  kind: 'ride',
  startDate: '2026-08-07',
  distanceMi: 10,
  elevationFt: 0,
  movingTime: 3600,
  trainer: false,
  ...over,
})

describe('heartRate', () => {
  it('reads as bpm when a monitor was worn', () => {
    expect(heartRate(activity({ avgHr: 142 }))).toBe('142 bpm')
  })

  it('rounds, because Strava reports a decimal that is noise on one line', () => {
    expect(heartRate(activity({ avgHr: 140.3 }))).toBe('140 bpm')
    expect(heartRate(activity({ avgHr: 140.7 }))).toBe('141 bpm')
  })

  it('says nothing for an activity with no heart rate', () => {
    expect(heartRate(activity())).toBeNull()
    expect(heartRate(activity({ avgHr: null }))).toBeNull()
  })

  it('treats zero as no reading, not as a reading of zero', () => {
    // A stored 0 would otherwise render "0 bpm" under a ride.
    expect(heartRate(activity({ avgHr: 0 }))).toBeNull()
  })

  it('ignores maxHr, which is served but not rendered on the log', () => {
    expect(heartRate(activity({ maxHr: 178 }))).toBeNull()
  })
})
