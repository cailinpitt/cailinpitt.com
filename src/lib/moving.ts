// Client for the activity API (Cloudflare Worker in /worker-moving), fetched in the browser
// like /reading and /watching. Interfaces mirror the Worker's by hand — not a shared package.

const API_BASE = import.meta.env.VITE_MOVING_API ?? 'https://moving.cailinpitt.com'

export type ActivityKind = 'ride' | 'ebike' | 'lift' | 'walk' | 'run' | 'yoga' | 'climb' | 'other'

export interface Activity {
  id: string
  sportType: string
  kind: ActivityKind
  /** YYYY-MM-DD, local to where it happened. */
  startDate: string
  distanceMi: number
  elevationFt: number
  movingTime: number
  trainer: boolean
  /** Average bpm, when recorded with a heart-rate monitor. Null/absent for most of the archive. */
  avgHr?: number | null
  /** Peak bpm, on the same terms. Served, but not rendered on the log. */
  maxHr?: number | null
  /** Unix seconds, UTC. Absent on a Worker deployed before the crossover. */
  startedAt?: number
  /** Moving time + 30min pause allowance, capped at what was recorded — the listening
   * Worker's tight "while moving" rule, deliberately not what soundtrackWindow() uses. */
  windowSeconds?: number
  /** The whole recorded span in seconds, pauses and all. */
  elapsedTime?: number
}

// The whole recorded span, not `windowSeconds` — stops (an errand, a coffee shop) are still
// part of the outing and the music kept playing. Falls back to windowSeconds only when an
// older Worker sends no elapsed time; under-including drops most of the answer (one 5h41m
// ride showed 5 of 37 tracks under the tight window), so the wider span is preferred.
export function soundtrackWindow(activity: Activity): { from: number; to: number } | null {
  const span = activity.elapsedTime ?? activity.windowSeconds
  if (!activity.startedAt || !span || span <= 0) return null
  return { from: activity.startedAt, to: activity.startedAt + span }
}

export interface ActivityPage {
  activities: Activity[]
  /** Opaque; pass straight back to fetchOlderActivities. Null means no more. */
  nextCursor: string | null
}

export interface MovingBundle extends ActivityPage {
  updatedAt: number
  counts: {
    activities: number
    rides: number
    lifts: number
    distanceMi: number
    movingTime: number
    activitiesThisYear: number
    ridesThisYear: number
    liftsThisYear: number
    distanceMiThisYear: number
    /** Ride + e-bike distance only, for the year — narrower than distanceMiThisYear. */
    bikeMilesThisYear: number
  }
}

/** Lightweight payload for the terminal (see /now.json). */
export interface ActivityNow {
  lastActivity: Activity | null
  updatedAt: number
}

export async function fetchMoving(signal?: AbortSignal): Promise<MovingBundle> {
  const res = await fetch(`${API_BASE}/moving.json`, { signal })
  if (!res.ok) throw new Error(`Activity API ${res.status}`)
  return res.json() as Promise<MovingBundle>
}

export async function fetchMovingNow(signal?: AbortSignal): Promise<ActivityNow> {
  const res = await fetch(`${API_BASE}/now.json`, { signal })
  if (!res.ok) throw new Error(`Activity API ${res.status}`)
  return res.json() as Promise<ActivityNow>
}

export async function fetchOlderActivities(
  cursor: string,
  limit = 30,
  signal?: AbortSignal,
): Promise<ActivityPage> {
  const res = await fetch(
    `${API_BASE}/activities?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
    { signal },
  )
  if (!res.ok) throw new Error(`Activity API ${res.status}`)
  return res.json() as Promise<ActivityPage>
}

// Nothing here names where the data comes from — the provider is a Worker implementation
// detail and stays out of anything rendered.

/** "1h 12m", or "48m" under the hour. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** What a row leads with: distance for anything that covered ground, else time. */
export function measure(activity: Activity): string {
  return activity.distanceMi > 0
    ? `${activity.distanceMi.toFixed(1)} mi`
    : duration(activity.movingTime)
}

const KIND_LABELS: Record<ActivityKind, string> = {
  ride: 'Ride',
  ebike: 'E-bike ride',
  lift: 'Lift',
  walk: 'Walk',
  run: 'Run',
  yoga: 'Yoga',
  climb: 'Climb',
  other: 'Activity',
}

export const kindLabel = (kind: ActivityKind): string => KIND_LABELS[kind] ?? 'Activity'

/** The bike gets the bolt, so a ride and an e-bike ride read apart at a glance. */
const KIND_ICONS: Record<ActivityKind, string> = {
  ride: '🚲',
  ebike: '🚲⚡',
  lift: '🏋️',
  walk: '🚶',
  run: '🏃',
  yoga: '🧘',
  climb: '🧗',
  other: '•',
}

export const kindIcon = (kind: ActivityKind): string => KIND_ICONS[kind] ?? KIND_ICONS.other

/** Kinds measured by how far, not how long. */
const DISTANCE_KINDS = new Set<ActivityKind>(['ride', 'ebike', 'walk', 'run'])

/** Past-tense verb for the summary line, by kind. */
const VERBS: Record<ActivityKind, string> = {
  ride: 'Biked',
  ebike: 'E-biked',
  lift: 'Lifted',
  walk: 'Walked',
  run: 'Ran',
  yoga: 'Yoga',
  climb: 'Climbed',
  other: 'Moved',
}

// Returns numbers, not a formatted string, since the row renders them as marked-up parts
// (heart glyph + labelled figures). Null and zero both mean "no monitor"; `max` can be null
// on its own since older rows may lack a peak even with an average.
export function heartRate(activity: Activity): { avg: number; max: number | null } | null {
  const bpm = (value: number | null | undefined) =>
    typeof value === 'number' && value > 0 ? Math.round(value) : null
  const avg = bpm(activity.avgHr)
  return avg === null ? null : { avg, max: bpm(activity.maxHr) }
}

// Built from the numbers, not the activity's own name, which is usually an autogenerated
// "Afternoon Ride" that says nothing.
export function summary(activity: Activity): string {
  const verb = VERBS[activity.kind] ?? VERBS.other
  if (DISTANCE_KINDS.has(activity.kind) && activity.distanceMi > 0) {
    return `${verb} ${activity.distanceMi.toFixed(1)} miles`
  }
  // Yoga reads "Yoga for 40m" rather than "Did yoga for 40m".
  return `${verb} for ${duration(activity.movingTime)}`
}


const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

// Parsed from the digits, not via Date: the string is already local to where the activity
// happened, and a UTC round-trip can slip a day.
export function longDate(date: string): string {
  const [year, month, day] = date.split('-')
  const index = Number(month) - 1
  return MONTHS[index] ? `${MONTHS[index]} ${Number(day)}, ${year}` : date
}

/** Rows grouped by date, newest first, for a log that reads as a diary. */
export function byDate(activities: Activity[]): { date: string; activities: Activity[] }[] {
  const groups: { date: string; activities: Activity[] }[] = []
  for (const activity of activities) {
    const last = groups[groups.length - 1]
    if (last && last.date === activity.startDate) last.activities.push(activity)
    else groups.push({ date: activity.startDate, activities: [activity] })
  }
  return groups
}
