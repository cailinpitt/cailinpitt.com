import { describe, expect, it } from 'vitest'
import { heartRate, soundtrackWindow, type Activity } from '../src/lib/moving'

// Heart rate exists only when a monitor was worn; these rules keep "no reading" from rendering as zero.

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

// Asks about the whole recording, not the movement window — getting this wrong is silent (a real ride once showed 5 of 37 tracks).

describe('soundtrackWindow', () => {
  const ride = (over: Partial<Activity> = {}) =>
    activity({ startedAt: 1_000_000, movingTime: 4383, elapsedTime: 20507, windowSeconds: 6183, ...over })

  it('spans the whole recording, pauses included', () => {
    // The real Aug 7 ride: 1h13m moving, 5h41m recorded across three cafes.
    expect(soundtrackWindow(ride())).toEqual({ from: 1_000_000, to: 1_020_507 })
  })

  it('does not use the movement window, which would close 4 hours early', () => {
    const span = soundtrackWindow(ride())!
    expect(span.to - span.from).toBe(20507)
    expect(span.to - span.from).not.toBe(6183)
  })

  it('falls back to the movement window when elapsed time is absent', () => {
    // An older moving Worker serves windowSeconds but no elapsedTime.
    expect(soundtrackWindow(ride({ elapsedTime: undefined }))).toEqual({
      from: 1_000_000,
      to: 1_006_183,
    })
  })

  it('is null when there is nothing to ask about', () => {
    expect(soundtrackWindow(ride({ startedAt: undefined }))).toBeNull()
    expect(soundtrackWindow(ride({ elapsedTime: undefined, windowSeconds: undefined }))).toBeNull()
    expect(soundtrackWindow(ride({ elapsedTime: 0, windowSeconds: undefined }))).toBeNull()
  })
})
