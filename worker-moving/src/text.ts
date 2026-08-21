// Terminal rendering of the activity bundle, for `curl`-style clients. Same
// conventions as the other workers' text.ts (72 columns, ANSI by default, `?T`
// to disable) — a separate copy since the packages share no module.

import type { Activity, MovingBundle } from './store'

const WIDTH = 72
const ROWS = 12

const CODES = {
  accent: '\x1b[38;5;173m',
  accentDim: '\x1b[38;5;137m',
  bold: '\x1b[1m',
  dim: '\x1b[38;5;244m',
  faint: '\x1b[38;5;240m',
  reset: '\x1b[0m',
}

type Paint = (s: string) => string

interface Ink {
  accent: Paint
  accentDim: Paint
  bold: Paint
  dim: Paint
  faint: Paint
}

function ink(color: boolean): Ink {
  const wrap = (code: string): Paint => (s) => (color ? `${code}${s}${CODES.reset}` : s)
  return {
    accent: wrap(CODES.accent),
    accentDim: wrap(CODES.accentDim),
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    faint: wrap(CODES.faint),
  }
}

function clip(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : clean.slice(0, Math.max(0, n - 1)) + '…'
}

/** Never use on the last field of a line: padding sits inside the color wrap. */
const fit = (s: string, n: number): string => clip(s, n).padEnd(n)

const num = (n: number) => n.toLocaleString('en-US')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Jul 9" from YYYY-MM-DD, read as written — no zone, so no day can slip. */
function shortDate(date: string): string {
  const [, month, day] = date.split('-')
  const index = Number(month) - 1
  return MONTHS[index] ? `${MONTHS[index]} ${Number(day)}` : date
}

/** "1h 12m", or "48m" under the hour. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** What a row says it was: distance for anything that covered ground, else time. */
export function measure(activity: Activity): string {
  return activity.distanceMi > 0
    ? `${activity.distanceMi.toFixed(1)} mi`
    : duration(activity.movingTime)
}

const MARKS: Record<string, string> = {
  ride: 'bike',
  ebike: 'ebike',
  lift: 'lift',
  walk: 'walk',
  run: 'run',
  yoga: 'yoga',
  climb: 'climb',
  dance: 'dance',
  other: '—',
}

const VERBS: Record<string, string> = {
  ride: 'Biked',
  ebike: 'E-biked',
  lift: 'Lifted',
  walk: 'Walked',
  run: 'Ran',
  yoga: 'Yoga',
  climb: 'Climbed',
  dance: 'Danced',
  other: 'Moved',
}

const DISTANCE_KINDS = new Set(['ride', 'ebike', 'walk', 'run'])

/** Mirrors summary() in src/lib/moving.ts. */
function summary(activity: Activity): string {
  const verb = VERBS[activity.kind] ?? VERBS.other
  return DISTANCE_KINDS.has(activity.kind) && activity.distanceMi > 0
    ? `${verb} ${activity.distanceMi.toFixed(1)} miles`
    : `${verb} for ${duration(activity.movingTime)}`
}

// " · <3 145 avg · 178 max", or nothing without a monitor. Mirrors heartRate()
// in src/lib/moving.ts; ASCII `<3` here instead of the page's ♥ since a
// mojibaked glyph is worse than a plain one on an unknown terminal encoding.
function heartRate(activity: Activity): string {
  const bpm = (value: number | null | undefined) =>
    typeof value === 'number' && value > 0 ? Math.round(value) : null
  const avg = bpm(activity.avgHr)
  if (avg === null) return ''
  const max = bpm(activity.maxHr)
  return ` · <3 ${avg} avg` + (max === null ? '' : ` · ${max} max`)
}

function activityLine(activity: Activity, c: Ink): string {
  const body = summary(activity) + heartRate(activity)
  return (
    c.dim(fit(shortDate(activity.startDate), 7)) +
    c.accentDim(fit(MARKS[activity.kind] ?? MARKS.other, 7)) +
    clip(body, WIDTH - 14)
  ).trimEnd()
}

export function renderText(
  bundle: MovingBundle,
  options: { color: boolean; year: number },
): string {
  const c = ink(options.color)
  const { counts } = bundle
  const lines: string[] = []

  lines.push(c.bold(c.accent('cailinpitt.com/moving')), c.faint('─'.repeat(WIDTH)), '')

  lines.push(
    c.dim(
      `${num(counts.activities)} activities · ${num(Math.round(counts.distanceMi))} mi · ` +
        `${num(counts.rides)} rides · ${num(counts.lifts)} lifts`,
    ),
    c.dim(
      `${options.year}: ${num(counts.activitiesThisYear)} activities · ` +
        `${num(Math.round(counts.bikeMilesThisYear))} bike mi · ` +
        `${num(counts.ridesThisYear)} rides · ${num(counts.liftsThisYear)} lifts`,
    ),
    '',
  )

  if (bundle.activities.length) {
    for (const activity of bundle.activities.slice(0, ROWS)) lines.push(activityLine(activity, c))
  } else {
    lines.push(c.dim('Nothing logged yet.'))
  }

  lines.push(
    '',
    // No provider named here or anywhere else user-facing — deliberate.
    c.faint('Rides and lifts, logged as they happen'),
    c.faint('The whole log → https://cailinpitt.com/moving'),
    '',
  )

  return lines.join('\n')
}
