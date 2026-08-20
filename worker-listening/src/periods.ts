// Period keys, bounds and labels. Every calendar op here uses the same fixed TZ
// offset as localDay() in stats.ts, so bounds and days never disagree. Weeks are
// ISO (Monday-start, `2026-W32`) — the /listening heatmap is Sunday-start
// instead since it's a picture of a year, not an addressable period.

const DAY = 86_400

export type PeriodKind = 'w' | 'm' | 'y' | 'all'

export interface Period {
  kind: PeriodKind
  key: string
  /** Unix seconds, inclusive. 0 for all-time. */
  start: number
  /** Unix seconds, exclusive. */
  end: number
  label: string
}

/** A Date whose UTC fields read as the local wall clock. */
function localDate(uts: number, offset: number): Date {
  return new Date((uts + offset) * 1000)
}

/** Inverse of localDate: a local Y/M/D back to unix seconds. */
function utsOf(year: number, month: number, day: number, offset: number): number {
  return Date.UTC(year, month, day) / 1000 - offset
}

/** Midnight-UTC Date for the Monday of d's ISO week. */
function isoWeekStart(d: Date): Date {
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // getUTCDay() is Sunday-based; shift so Monday is 0.
  monday.setUTCDate(monday.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return monday
}

// ISO year is the year of the week's Thursday, not getUTCFullYear() — late
// December often belongs to week 1 of the next year.
function isoWeekKeyOf(d: Date): string {
  const thursday = isoWeekStart(d)
  thursday.setUTCDate(thursday.getUTCDate() + 3)
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY * 1000)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

export const weekKey = (uts: number, offset: number) => isoWeekKeyOf(localDate(uts, offset))

export function monthKey(uts: number, offset: number): string {
  const d = localDate(uts, offset)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const yearKey = (uts: number, offset: number) => String(localDate(uts, offset).getUTCFullYear())

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3))

const KEY_PATTERN: Record<Exclude<PeriodKind, 'all'>, RegExp> = {
  w: /^(\d{4})-W(\d{2})$/,
  m: /^(\d{4})-(\d{2})$/,
  y: /^(\d{4})$/,
}

/** Parse a key into its period, or null if the key is malformed. */
export function parsePeriod(kind: string, key: string, offset: number): Period | null {
  if (kind === 'all') {
    return { kind: 'all', key: 'all', start: 0, end: Infinity, label: 'All time' }
  }
  if (kind !== 'w' && kind !== 'm' && kind !== 'y') return null

  const match = key.match(KEY_PATTERN[kind])
  if (!match) return null

  if (kind === 'y') {
    const year = Number(match[1])
    if (year < 1970 || year > 2200) return null
    return {
      kind,
      key,
      start: utsOf(year, 0, 1, offset),
      end: utsOf(year + 1, 0, 1, offset),
      label: key,
    }
  }

  if (kind === 'm') {
    const [year, month] = [Number(match[1]), Number(match[2])]
    if (month < 1 || month > 12) return null
    return {
      kind,
      key,
      start: utsOf(year, month - 1, 1, offset),
      end: utsOf(year, month, 1, offset),
      label: `${MONTHS[month - 1]} ${year}`,
    }
  }

  const [year, week] = [Number(match[1]), Number(match[2])]
  if (week < 1 || week > 53) return null
  // January 4th is by definition in ISO week 1, so it anchors the whole year.
  const firstMonday = isoWeekStart(new Date(Date.UTC(year, 0, 4)))
  const start = new Date(firstMonday)
  start.setUTCDate(start.getUTCDate() + (week - 1) * 7)
  // Week 53 doesn't exist in most years; reject rather than silently roll over.
  if (isoWeekKeyOf(start) !== key) return null

  const startUts = utsOf(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), offset)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 7)
  return {
    kind,
    key,
    start: startUts,
    end: utsOf(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), offset),
    label: `Week of ${SHORT_MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}, ${start.getUTCFullYear()}`,
  }
}

/** The period of the given kind containing `uts`. */
export function periodContaining(kind: PeriodKind, uts: number, offset: number): Period {
  const key =
    kind === 'all'
      ? 'all'
      : kind === 'w'
        ? weekKey(uts, offset)
        : kind === 'm'
          ? monthKey(uts, offset)
          : yearKey(uts, offset)
  // The key was just built from a real timestamp, so it always parses.
  return parsePeriod(kind, key, offset)!
}

/** The period immediately before this one — for deltas and rank movement. */
export function previousPeriod(period: Period, offset: number): Period | null {
  if (period.kind === 'all' || period.start <= 0) return null
  return periodContaining(period.kind, period.start - 1, offset)
}

/** The same period one year earlier, or null where it has no counterpart. */
export function yearAgoPeriod(period: Period, offset: number): Period | null {
  if (period.kind === 'all') return null
  const d = localDate(period.start, offset)
  const shifted = utsOf(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate(), offset)
  return periodContaining(period.kind, shifted, offset)
}

// Steps past the end of each period rather than adding a fixed number of days,
// so month lengths and 52/53-week years need no special case.
export function enumeratePeriods(
  kind: Exclude<PeriodKind, 'all'>,
  from: number,
  to: number,
  offset: number,
): Period[] {
  const out: Period[] = []
  let cursor = periodContaining(kind, from, offset)
  // A malformed archive (to < from) must not spin here.
  while (cursor.start <= to && out.length < 5000) {
    out.push(cursor)
    cursor = periodContaining(kind, cursor.end, offset)
  }
  return out
}

/** Local YYYY-MM-DD, matching localDay() in stats.ts. */
export function dayKey(uts: number, offset: number): string {
  return new Date((uts + offset) * 1000).toISOString().slice(0, 10)
}

/** Local hour (0–23). */
export const hourOf = (uts: number, offset: number) => localDate(uts, offset).getUTCHours()

/** Local weekday, Monday = 0, to match the ISO weeks used for keys. */
export const weekdayOf = (uts: number, offset: number) =>
  (localDate(uts, offset).getUTCDay() + 6) % 7
