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
  it('reports the average and the peak when a monitor was worn', () => {
    expect(heartRate(activity({ avgHr: 145, maxHr: 178 }))).toEqual({ avg: 145, max: 178 })
  })

  it('rounds, because Strava reports a decimal that is noise on one line', () => {
    expect(heartRate(activity({ avgHr: 140.3, maxHr: 177.5 }))).toEqual({ avg: 140, max: 178 })
  })

  it('says nothing for an activity with no heart rate', () => {
    expect(heartRate(activity())).toBeNull()
    expect(heartRate(activity({ avgHr: null, maxHr: null }))).toBeNull()
  })

  it('treats zero as no reading, not as a reading of zero', () => {
    // A stored 0 would otherwise render "0 avg" under a ride.
    expect(heartRate(activity({ avgHr: 0, maxHr: 0 }))).toBeNull()
  })

  it('keeps the average when only the peak is missing', () => {
    // The two are separate fields; the row renders whichever it gets.
    expect(heartRate(activity({ avgHr: 145 }))).toEqual({ avg: 145, max: null })
    expect(heartRate(activity({ avgHr: 145, maxHr: 0 }))).toEqual({ avg: 145, max: null })
  })

  it('is null when there is a peak but no average, rather than half a reading', () => {
    expect(heartRate(activity({ maxHr: 178 }))).toBeNull()
  })
})
