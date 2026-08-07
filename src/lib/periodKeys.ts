// Period keys, URLs and navigation for /listening.
//
// Mirrors worker-listening/src/periods.ts, minus the timezone offset: the Worker
// decides which local day a scrobble belongs to, and by the time a key reaches
// the browser it is already a plain calendar label. Everything here is string
// and UTC-date arithmetic, so it produces identical output in a Node build and
// in a browser in any timezone.

import { FIRST_LISTENING_YEAR } from './listeningYears'

export type PeriodKind = 'w' | 'm' | 'y' | 'all'

/** First day with scrobbles. Constant so the build never has to ask the API. */
export const FIRST_LISTENING_DAY = '2021-03-01'

const DAY_MS = 86_400_000

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3))

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)

/** Monday of the ISO week containing d. */
function isoWeekStart(d: Date): Date {
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return monday
}

/** ISO week key. The year is the week's Thursday's year, not the Monday's. */
export function weekKeyOf(d: Date): string {
  const thursday = isoWeekStart(d)
  thursday.setUTCDate(thursday.getUTCDate() + 3)
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

export const monthKeyOf = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`

export const yearKeyOf = (d: Date) => String(d.getUTCFullYear())

/** Monday of an ISO week key, or null if the key is malformed. */
export function weekStartOf(key: string): Date | null {
  const m = key.match(/^(\d{4})-W(\d{2})$/)
  if (!m) return null
  const [year, week] = [Number(m[1]), Number(m[2])]
  // Jan 4 is always in ISO week 1, so it anchors the year.
  const start = isoWeekStart(new Date(Date.UTC(year, 0, 4)))
  start.setUTCDate(start.getUTCDate() + (week - 1) * 7)
  return weekKeyOf(start) === key ? start : null
}

export function labelFor(kind: PeriodKind, key: string): string {
  if (kind === 'all') return 'All time'
  if (kind === 'y') return key
  if (kind === 'm') {
    const [year, month] = key.split('-').map(Number)
    return `${MONTHS[month - 1]} ${year}`
  }
  const start = weekStartOf(key)
  if (!start) return key
  return `Week of ${SHORT_MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}, ${start.getUTCFullYear()}`
}

/** Short label for the navigator, where the granularity is already obvious. */
export function shortLabelFor(kind: PeriodKind, key: string): string {
  if (kind === 'all') return 'All time'
  if (kind === 'y') return key
  if (kind === 'm') return MONTHS[Number(key.split('-')[1]) - 1]
  const start = weekStartOf(key)
  return start ? `${SHORT_MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}` : key
}

/** URL for a period. Years and all-time sit one level down, weeks and months two. */
export function urlFor(kind: PeriodKind, key: string): string {
  if (kind === 'all') return '/listening/all'
  if (kind === 'y') return `/listening/${key}`
  if (kind === 'm') return `/listening/${key.slice(0, 4)}/${key.slice(5)}`
  return `/listening/${key.slice(0, 4)}/${key.slice(5)}`
}

/**
 * Turn route params back into a period.
 *
 * `/listening/2026/08` is a month and `/listening/2026/W32` is a week — the `W`
 * is what separates them, which is also why week keys keep it in the URL.
 */
export function parseRoute(a?: string, b?: string): { kind: PeriodKind; key: string } | null {
  if (!a) return null
  if (a === 'all') return { kind: 'all', key: 'all' }
  if (!/^\d{4}$/.test(a)) return null
  if (!b) return { kind: 'y', key: a }
  if (/^W\d{2}$/.test(b)) {
    const key = `${a}-${b}`
    return weekStartOf(key) ? { kind: 'w', key } : null
  }
  if (/^\d{2}$/.test(b)) {
    const month = Number(b)
    return month >= 1 && month <= 12 ? { kind: 'm', key: `${a}-${b}` } : null
  }
  return null
}

/** Step a period forward or back. Returns null past the ends of the archive. */
export function step(
  kind: PeriodKind,
  key: string,
  direction: 1 | -1,
  now = new Date(),
): string | null {
  if (kind === 'all') return null

  let next: string
  if (kind === 'y') {
    next = String(Number(key) + direction)
  } else if (kind === 'm') {
    const [year, month] = key.split('-').map(Number)
    const d = new Date(Date.UTC(year, month - 1 + direction, 1))
    next = monthKeyOf(d)
  } else {
    const start = weekStartOf(key)
    if (!start) return null
    start.setUTCDate(start.getUTCDate() + 7 * direction)
    next = weekKeyOf(start)
  }

  return withinArchive(kind, next, now) ? next : null
}

/** Is this period inside [first scrobble, now]? */
export function withinArchive(kind: PeriodKind, key: string, now = new Date()): boolean {
  if (kind === 'all') return true
  const first = utc(FIRST_LISTENING_DAY)
  if (kind === 'y') {
    return Number(key) >= first.getUTCFullYear() && Number(key) <= now.getUTCFullYear()
  }
  if (kind === 'm') {
    return key >= monthKeyOf(first) && key <= monthKeyOf(now)
  }
  const start = weekStartOf(key)
  if (!start) return false
  // Compare by the week's Monday, so the partial first and current weeks count.
  return start.getTime() >= isoWeekStart(first).getTime() && start.getTime() <= now.getTime()
}

/** The period of `kind` containing today — where the navigator starts. */
export function currentKey(kind: PeriodKind, now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (kind === 'all') return 'all'
  if (kind === 'y') return yearKeyOf(d)
  if (kind === 'm') return monthKeyOf(d)
  return weekKeyOf(d)
}

/**
 * The equivalent period at another granularity, so switching week → month keeps
 * you roughly where you were instead of jumping to today.
 */
export function convertKey(from: PeriodKind, key: string, to: PeriodKind): string {
  if (to === 'all') return 'all'
  if (from === 'all') return currentKey(to)

  const anchor =
    from === 'w'
      ? weekStartOf(key)
      : from === 'm'
        ? utc(`${key}-01`)
        : utc(`${key}-01-01`)
  if (!anchor) return currentKey(to)

  const converted = to === 'y' ? yearKeyOf(anchor) : to === 'm' ? monthKeyOf(anchor) : weekKeyOf(anchor)
  return withinArchive(to, converted) ? converted : currentKey(to)
}

/** Every year/month/week the archive covers, newest first. For prerendering. */
export function allPeriods(now = new Date()): { kind: PeriodKind; key: string }[] {
  const out: { kind: PeriodKind; key: string }[] = [{ kind: 'all', key: 'all' }]
  const first = utc(FIRST_LISTENING_DAY)

  for (let y = now.getUTCFullYear(); y >= FIRST_LISTENING_YEAR; y--) {
    out.push({ kind: 'y', key: String(y) })
  }

  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const firstMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1))
  for (let d = month; d >= firstMonth; d.setUTCMonth(d.getUTCMonth() - 1)) {
    out.push({ kind: 'm', key: monthKeyOf(d) })
  }

  const week = isoWeekStart(now)
  const firstWeek = isoWeekStart(first)
  for (let d = week; d >= firstWeek; d.setUTCDate(d.getUTCDate() - 7)) {
    out.push({ kind: 'w', key: weekKeyOf(d) })
  }

  return out
}
