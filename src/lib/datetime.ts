// formatTime/formatRelative render in the viewer's local zone. formatDayLabel instead takes
// an already-bucketed YYYY-MM-DD key (bucketed client-side, or server-side into US Central
// days by the listening Worker — see TZ_OFFSET_SECONDS in worker-listening/wrangler.jsonc)
// and formats it as UTC so the date never shifts — meaning a bucket can read "Yesterday" for
// a track whose local time is today.

const timeFmt = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
})

// UTC because the input is a date-only key parsed at noon UTC: this prints
// exactly the date in the key, with no zone able to nudge it a day either way.
const dayFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

const numFmt = new Intl.NumberFormat('en-US')

// en-CA gives an ISO-ish YYYY-MM-DD. No timeZone, so it uses the browser's.
const keyFmt = new Intl.DateTimeFormat('en-CA')

export const formatNumber = (n: number) => numFmt.format(n)

/** Clock time of an instant, in the viewer's timezone. */
export const formatTime = (uts: number) => timeFmt.format(uts * 1000)

/** The local YYYY-MM-DD key a unix timestamp falls in. */
export const dayKey = (uts: number): string => keyFmt.format(uts * 1000)

/** The local YYYY-MM-DD key `days` away from today. */
export const keyForOffset = (days: number): string => keyFmt.format(Date.now() + days * 86_400_000)

/** `date` shifted by `delta` calendar days (negative goes back) — pure date-string math. */
export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10)
}

/** "Today" / "Yesterday" / "Monday, June 9" from a YYYY-MM-DD key. */
export function formatDayLabel(date: string): string {
  if (date === keyForOffset(0)) return 'Today'
  if (date === keyForOffset(-1)) return 'Yesterday'
  // Noon UTC so the date can't slip across a boundary before being formatted.
  return dayFmt.format(new Date(`${date}T12:00:00Z`))
}

/** Compact "just now / 5m ago / 3h ago / 2d ago" from unix seconds. */
export function formatRelative(uts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - uts)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
}
