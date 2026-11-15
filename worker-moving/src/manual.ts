// Activities that don't come from Strava: scooter rides, posted one at a time by
// the scooter logger on the home server through `POST /activities`.
// No imports, so the site's tests can load it without the Workers types.

/** Namespaced so it can never collide with a Strava id, which is all digits. */
const ID = /^scooter-\d{1,12}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_MILES = 200

export interface ScooterRide {
  id: string
  /** Unix seconds, UTC. */
  startedAt: number
  /** YYYY-MM-DD, local to the rider. */
  startDate: string
  distanceMi: number
  movingTime: number
  elapsedTime: number
  /** Percent at the start and end, or null when the logger doesn't know. */
  batteryStart: number | null
  batteryEnd: number | null
  /** Watt-hours used across both batteries, or null. */
  energyWh: number | null
}

export interface ScooterStatus {
  odometerMi: number
  /** Lifetime seconds with the wheels turning. */
  ridingTime: number
  /** Unix seconds of the reading. */
  readAt: number
  /** Both batteries when full, for the range estimate; null when not sent. */
  fullWh: number | null
}

const MAX_ODOMETER_MI = 100_000
const MAX_WH = 10_000

const percent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100

const wholeSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/** The posted body as a ride, or the reason it isn't one. */
export function parseScooterRide(body: unknown): ScooterRide | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object'
  const b = body as Record<string, unknown>
  if (typeof b.id !== 'string' || !ID.test(b.id)) return 'id must look like scooter-<digits>'
  if (!wholeSeconds(b.startedAt)) return 'startedAt must be unix seconds'
  if (typeof b.startDate !== 'string' || !DATE.test(b.startDate)) return 'startDate must be YYYY-MM-DD'
  if (typeof b.distanceMi !== 'number' || !(b.distanceMi > 0 && b.distanceMi < MAX_MILES)) {
    return `distanceMi must be between 0 and ${MAX_MILES}`
  }
  if (!wholeSeconds(b.movingTime)) return 'movingTime must be whole seconds'
  const elapsedTime = b.elapsedTime ?? b.movingTime
  if (!wholeSeconds(elapsedTime)) return 'elapsedTime must be whole seconds'
  const batteryStart = b.batteryStart ?? null
  const batteryEnd = b.batteryEnd ?? null
  if (batteryStart !== null && !percent(batteryStart)) return 'batteryStart must be a whole percent'
  if (batteryEnd !== null && !percent(batteryEnd)) return 'batteryEnd must be a whole percent'
  const energyWh = b.energyWh ?? null
  if (energyWh !== null && !(wholeSeconds(energyWh) && energyWh > 0 && energyWh < MAX_WH)) {
    return `energyWh must be a whole number between 0 and ${MAX_WH}`
  }
  return {
    id: b.id,
    startedAt: b.startedAt,
    startDate: b.startDate,
    distanceMi: Math.round(b.distanceMi * 100) / 100,
    movingTime: b.movingTime,
    elapsedTime: Math.max(elapsedTime, b.movingTime),
    batteryStart,
    batteryEnd,
    energyWh,
  }
}

/** The posted odometer reading, or the reason it isn't one. */
export function parseScooterStatus(body: unknown): ScooterStatus | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object'
  const b = body as Record<string, unknown>
  if (typeof b.odometerMi !== 'number' || !(b.odometerMi >= 0 && b.odometerMi < MAX_ODOMETER_MI)) {
    return `odometerMi must be between 0 and ${MAX_ODOMETER_MI}`
  }
  const ridingTime = b.ridingTime ?? 0
  if (!wholeSeconds(ridingTime)) return 'ridingTime must be whole seconds'
  if (!wholeSeconds(b.readAt)) return 'readAt must be unix seconds'
  const fullWh = b.fullWh ?? null
  if (fullWh !== null && !(wholeSeconds(fullWh) && fullWh > 0 && fullWh < MAX_WH)) {
    return `fullWh must be a whole number between 0 and ${MAX_WH}`
  }
  return { odometerMi: Math.round(b.odometerMi * 10) / 10, ridingTime, readAt: b.readAt, fullWh }
}
