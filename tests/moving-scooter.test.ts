import { describe, expect, it } from 'vitest'
import { parseScooterRide, parseScooterStatus } from '../worker-moving/src/manual'
import { avgSpeed, batteryDrop, drivingSaved, kindIcon, measure, summary, type Activity } from '../src/lib/moving'

const body = (over: Record<string, unknown> = {}) => ({
  id: 'scooter-1763076000',
  startedAt: 1763074800,
  startDate: '2026-11-13',
  distanceMi: 5.219,
  movingTime: 1200,
  elapsedTime: 1500,
  ...over,
})

describe('parseScooterRide', () => {
  it('accepts a ride from the logger, rounding the distance', () => {
    expect(parseScooterRide(body())).toEqual({ ...body(), distanceMi: 5.22, batteryStart: null, batteryEnd: null })
  })

  it('defaults elapsed time to moving time, and never lets it be shorter', () => {
    expect(parseScooterRide(body({ elapsedTime: undefined }))).toMatchObject({ elapsedTime: 1200 })
    expect(parseScooterRide(body({ elapsedTime: 600 }))).toMatchObject({ elapsedTime: 1200 })
  })

  it('only takes namespaced ids, so a post can never overwrite a Strava activity', () => {
    expect(parseScooterRide(body({ id: '12345678901' }))).toBeTypeOf('string')
    expect(parseScooterRide(body({ id: 'scooter-abc' }))).toBeTypeOf('string')
  })

  it('rejects distances that cannot be a scooter ride', () => {
    expect(parseScooterRide(body({ distanceMi: 0 }))).toBeTypeOf('string')
    expect(parseScooterRide(body({ distanceMi: 500 }))).toBeTypeOf('string')
    expect(parseScooterRide(body({ distanceMi: '5' }))).toBeTypeOf('string')
  })

  it('rejects malformed dates and times', () => {
    expect(parseScooterRide(body({ startDate: '11/13/2026' }))).toBeTypeOf('string')
    expect(parseScooterRide(body({ startedAt: -1 }))).toBeTypeOf('string')
    expect(parseScooterRide(body({ movingTime: 12.5 }))).toBeTypeOf('string')
    expect(parseScooterRide(null)).toBeTypeOf('string')
    expect(parseScooterRide([])).toBeTypeOf('string')
  })
})

describe('scooter rows', () => {
  const ride: Activity = {
    id: 'scooter-1763076000',
    sportType: 'Scooter',
    kind: 'scooter',
    startDate: '2026-11-13',
    distanceMi: 5.22,
    elevationFt: 0,
    movingTime: 1200,
    trainer: false,
  }

  it('reads by distance, like a ride', () => {
    expect(summary(ride)).toBe('Scooted 5.2 miles')
    expect(measure(ride)).toBe('5.2 mi')
    expect(kindIcon(ride.kind)).toBe('🛴')
  })
})

describe('scooter battery and odometer', () => {
  it('takes optional whole-percent battery levels', () => {
    expect(parseScooterRide(body())).toMatchObject({ batteryStart: null, batteryEnd: null })
    expect(parseScooterRide(body({ batteryStart: 78, batteryEnd: 54 }))).toMatchObject({
      batteryStart: 78,
      batteryEnd: 54,
    })
    expect(parseScooterRide(body({ batteryStart: 101 }))).toBeTypeOf('string')
    expect(parseScooterRide(body({ batteryEnd: 54.5 }))).toBeTypeOf('string')
  })

  it('parses an odometer reading', () => {
    expect(parseScooterStatus({ odometerMi: 273.74, ridingTime: 50000, readAt: 1794639706 })).toEqual({
      odometerMi: 273.7,
      ridingTime: 50000,
      readAt: 1794639706,
    })
    expect(parseScooterStatus({ odometerMi: -1, readAt: 1 })).toBeTypeOf('string')
    expect(parseScooterStatus({ odometerMi: 10 })).toBeTypeOf('string')
  })

  it('shows the drop only when both ends are known', () => {
    const ride = { batteryStart: 78, batteryEnd: 54 } as Activity
    expect(batteryDrop(ride)).toBe('78% → 54%')
    expect(batteryDrop({ batteryStart: null, batteryEnd: 54 } as Activity)).toBeNull()
  })

  it('prices the miles as gas-car driving', () => {
    const saved = drivingSaved(220)
    expect(saved.dollars).toBeCloseTo(31, 0)
    expect(Math.round(saved.co2Lb)).toBe(194)
  })
})

describe('avgSpeed', () => {
  const ride = { kind: 'scooter', distanceMi: 2.55, movingTime: 510 } as Activity

  it('is distance over wheel time, for scooter rides only', () => {
    expect(avgSpeed(ride)).toBe('18 mph')
    expect(avgSpeed({ ...ride, kind: 'ride' })).toBeNull()
    expect(avgSpeed({ ...ride, movingTime: 0 })).toBeNull()
  })
})
