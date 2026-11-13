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
}

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
  return {
    id: b.id,
    startedAt: b.startedAt,
    startDate: b.startDate,
    distanceMi: Math.round(b.distanceMi * 100) / 100,
    movingTime: b.movingTime,
    elapsedTime: Math.max(elapsedTime, b.movingTime),
  }
}
