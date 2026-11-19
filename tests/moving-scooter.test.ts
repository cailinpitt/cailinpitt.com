import { describe, expect, it } from 'vitest'
import { parseScooterRide, parseScooterStatus } from '../worker-moving/src/manual'
import { gasSaved, parseEiaPrices, priceOn } from '../worker-moving/src/gas'
import { avgSpeed, batteryDrop, drivingSaved, efficiency, fullChargeRange, rideGasSaved, kindIcon, measure, summary, type Activity } from '../src/lib/moving'

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
    expect(parseScooterRide(body())).toEqual({
      ...body(),
      distanceMi: 5.22,
      batteryStart: null,
      batteryEnd: null,
      energyWh: null,
    })
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
      fullWh: null,
    })
    expect(parseScooterStatus({ odometerMi: -1, readAt: 1 })).toBeTypeOf('string')
    expect(parseScooterStatus({ odometerMi: 10 })).toBeTypeOf('string')
  })

  it('shows the drop, or just the level left when the start is unknown', () => {
    expect(batteryDrop({ batteryStart: 78, batteryEnd: 54 } as Activity)).toBe('78% → 54%')
    expect(batteryDrop({ batteryStart: null, batteryEnd: 54 } as Activity)).toBe('54% left')
    expect(batteryDrop({ batteryStart: 78, batteryEnd: null } as Activity)).toBeNull()
  })

  it('prices the miles as gas-car driving', () => {
    const saved = drivingSaved(220)
    expect(saved.dollars).toBeCloseTo(34.5, 1)
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

describe('scooter efficiency', () => {
  it('takes optional whole watt-hours', () => {
    expect(parseScooterRide(body({ energyWh: 163 }))).toMatchObject({ energyWh: 163 })
    expect(parseScooterRide(body({ energyWh: -5 }))).toBeTypeOf('string')
    expect(parseScooterStatus({ odometerMi: 283, readAt: 1, fullWh: 1184 })).toMatchObject({ fullWh: 1184 })
  })

  it('shows Wh per mile on scooter rides that have it', () => {
    const ride = { kind: 'scooter', distanceMi: 5.22, energyWh: 163 } as Activity
    expect(efficiency(ride)).toBe('31 Wh/mi')
    expect(efficiency({ ...ride, energyWh: null })).toBeNull()
  })

  it('estimates a full-charge range from the average', () => {
    const totals = { odometerMi: 283, ridingTime: 0, readAt: 0 }
    expect(fullChargeRange({ ...totals, fullWh: 1184, whPerMi: 31.2 })).toBe(38)
    expect(fullChargeRange({ ...totals, fullWh: 1184, whPerMi: null })).toBeNull()
  })
})

describe('gas prices', () => {
  const prices = [
    { week: '2026-11-02', price: 3.7 },
    { week: '2026-11-09', price: 3.6 },
    { week: '2026-11-16', price: 3.4 },
  ]

  it('reads the EIA response, whose values are strings', () => {
    const body = {
      response: {
        data: [
          { period: '2026-11-16', value: '3.436' },
          { period: '2026-11-09', value: null },
          { period: 'bad', value: '3.5' },
        ],
      },
    }
    expect(parseEiaPrices(body)).toEqual([{ week: '2026-11-16', price: 3.436 }])
    expect(parseEiaPrices({ error: 'no key' })).toEqual([])
  })

  it('uses the week a date falls in, or the earliest week before the data starts', () => {
    expect(priceOn('2026-11-12', prices)).toBe(3.6)
    expect(priceOn('2026-11-16', prices)).toBe(3.4)
    expect(priceOn('2026-10-01', prices)).toBe(3.7)
  })

  it('prices each ride at its week, and older odometer miles at the first ride\'s week', () => {
    const rides = [
      { startDate: '2026-11-17', distanceMi: 22 },
      { startDate: '2026-11-03', distanceMi: 22 },
    ]
    // 22 mi at 3.70 + 22 mi at 3.40 + 66 older mi at 3.70, all at 22 mpg
    expect(gasSaved(rides, prices, 110)).toBeCloseTo(3.7 + 3.4 + 3 * 3.7, 2)
    expect(gasSaved(rides, [], 110)).toBeNull()
  })
})

describe('rideGasSaved', () => {
  it('shows a scooter ride\'s priced savings in dollars and cents', () => {
    const ride = { kind: 'scooter', gasSaved: 0.4747 } as Activity
    expect(rideGasSaved(ride)).toBe('$0.47 gas saved')
    expect(rideGasSaved({ ...ride, gasSaved: null })).toBeNull()
    expect(rideGasSaved({ ...ride, kind: 'ride' })).toBeNull()
  })
})
