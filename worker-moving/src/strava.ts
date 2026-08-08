// Strava API: token refresh and the activity list.

const TOKEN_URL = 'https://www.strava.com/api/v3/oauth/token'
const API = 'https://www.strava.com/api/v3'

/** Refresh this early, so a token can't expire mid-run. */
const EXPIRY_SKEW = 300

/**
 * Coarse bucket the page groups on. `ride` and `ebike` are split because they
 * are different efforts, and the log labels them differently.
 */
export type ActivityKind = 'ride' | 'ebike' | 'lift' | 'walk' | 'run' | 'yoga' | 'climb' | 'other'

export interface SummaryActivity {
  id: string
  name: string
  sportType: string
  kind: ActivityKind
  startDate: string
  startedAt: number
  distanceMi: number
  elevationFt: number
  movingTime: number
  elapsedTime: number
  trainer: boolean
  commute: boolean
  /** Average bpm, or null when the activity carries no heart rate. */
  avgHr: number | null
  /** Peak bpm, or null. */
  maxHr: number | null
}

const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.280839895

/**
 * sport_type → bucket. Kept in sync by hand with the same table in
 * scripts/moving-backfill.mjs, which reads the export's older `type`
 * vocabulary (spaces and hyphens, e.g. "E-Bike Ride").
 */
const KINDS: Record<string, ActivityKind> = {
  Ride: 'ride',
  GravelRide: 'ride',
  MountainBikeRide: 'ride',
  VirtualRide: 'ride',
  EBikeRide: 'ebike',
  EMountainBikeRide: 'ebike',
  WeightTraining: 'lift',
  Crossfit: 'lift',
  Walk: 'walk',
  Hike: 'walk',
  Run: 'run',
  TrailRun: 'run',
  VirtualRun: 'run',
  Yoga: 'yoga',
  RockClimbing: 'climb',
  RockClimb: 'climb',
}

const kindOf = (sportType: string): ActivityKind => KINDS[sportType] ?? 'other'

const round = (n: number, places: number): number => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_at: number
}

/**
 * A usable access token, refreshing when the stored one is near expiry.
 *
 * Strava returns a new refresh token on every exchange and invalidates the old
 * one, so the result is written back to `auth` before it is used for anything.
 */
export async function accessToken(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT refresh_token, access_token, expires_at FROM auth WHERE id = 1',
  ).first<{ refresh_token: string | null; access_token: string | null; expires_at: number }>()

  const now = Math.floor(Date.now() / 1000)
  if (row?.access_token && row.expires_at > now + EXPIRY_SKEW) return row.access_token

  // Falls back to the seed secret only on the very first run, before the table
  // has ever held a token.
  const refresh = row?.refresh_token || env.STRAVA_REFRESH_TOKEN
  if (!refresh) throw new Error('No refresh token: set the STRAVA_REFRESH_TOKEN secret')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refresh,
    }),
  })
  if (!res.ok) {
    throw new Error(`Strava token refresh failed: ${res.status} ${await res.text()}`)
  }
  const token = (await res.json()) as TokenResponse

  await env.DB.prepare(
    `UPDATE auth SET refresh_token = ?1, access_token = ?2, expires_at = ?3, updated_at = ?4
     WHERE id = 1`,
  )
    .bind(token.refresh_token, token.access_token, token.expires_at, now)
    .run()

  return token.access_token
}

interface RawActivity {
  id: number
  name: string
  sport_type?: string
  type?: string
  start_date: string
  start_date_local: string
  distance?: number
  total_elevation_gain?: number
  moving_time?: number
  elapsed_time?: number
  trainer?: boolean
  commute?: boolean
  has_heartrate?: boolean
  average_heartrate?: number
  max_heartrate?: number
}

/**
 * Heart rate, or null when the activity wasn't recorded with a monitor.
 *
 * Strava sends these on the activity *summary*, so the log gets them for free —
 * no per-activity request, and no change to the rate-limit budget.
 *
 * `has_heartrate` is checked rather than trusting the numbers: it is false on an
 * activity with no monitor, where the averages are absent entirely. Rounded to
 * whole bpm, and a non-positive reading is treated as no reading at all.
 */
function heartRate(raw: RawActivity): { avgHr: number | null; maxHr: number | null } {
  if (!raw.has_heartrate) return { avgHr: null, maxHr: null }
  const bpm = (value: number | undefined) =>
    typeof value === 'number' && value > 0 ? Math.round(value) : null
  return { avgHr: bpm(raw.average_heartrate), maxHr: bpm(raw.max_heartrate) }
}

function toActivity(raw: RawActivity): SummaryActivity {
  const sportType = raw.sport_type ?? raw.type ?? 'Workout'
  return {
    id: String(raw.id),
    name: raw.name,
    sportType,
    kind: kindOf(sportType),
    // start_date_local is an ISO string already shifted into the athlete's
    // zone, so the date is taken from its digits rather than via Date.
    startDate: raw.start_date_local.slice(0, 10),
    startedAt: Math.floor(new Date(raw.start_date).getTime() / 1000),
    distanceMi: round((raw.distance ?? 0) / METERS_PER_MILE, 2),
    elevationFt: round((raw.total_elevation_gain ?? 0) * FEET_PER_METER, 0),
    movingTime: raw.moving_time ?? 0,
    elapsedTime: raw.elapsed_time ?? 0,
    trainer: Boolean(raw.trainer),
    commute: Boolean(raw.commute),
    ...heartRate(raw),
  }
}

/** Strava's maximum. */
export const PER_PAGE = 200

/**
 * One page of the athlete's activities, newest first.
 *
 * `after` bounds a run to recent activity; `before` walks backwards into the
 * archive. Both are unix seconds. Paging stops when a page comes back short.
 */
export async function fetchActivities(
  token: string,
  options: { page: number; after?: number; before?: number; perPage?: number },
): Promise<SummaryActivity[]> {
  const url = new URL(`${API}/athlete/activities`)
  url.searchParams.set('page', String(options.page))
  url.searchParams.set('per_page', String(options.perPage ?? PER_PAGE))
  if (options.after) url.searchParams.set('after', String(options.after))
  if (options.before) url.searchParams.set('before', String(options.before))

  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status === 429) throw new Error('Strava rate limit reached; try again later')
  if (!res.ok) throw new Error(`Strava activities failed: ${res.status} ${await res.text()}`)

  const raw = (await res.json()) as RawActivity[]
  return raw.map(toActivity)
}
