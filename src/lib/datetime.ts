// Date/time formatting shared by the activity pages (/listening, /reading).
//
// ## Everything a visitor reads as a clock is in *their* timezone
//
// A scrobble or an article is an instant, and `formatTime` / `formatRelative`
// render it in the browser's local zone — a visitor in Berlin sees the time
// their own clock showed, not Cailin's. Nothing here pins a zone.
//
// ## Day *labels* name a calendar date, not a zone
//
// `formatDayLabel` takes a YYYY-MM-DD key that has already been bucketed —
// client-side from local timestamps on /reading, server-side by the listening
// Worker (which groups scrobbles into US Central days; see TZ_OFFSET_SECONDS in
// worker/wrangler.jsonc). So it formats the key *as written*, in UTC, rather
// than reinterpreting it in some other zone and printing a different date than
// the one it was handed. "Today"/"Yesterday" then compare that date against the
// viewer's own calendar date, which is what makes those two words true for the
// person reading them.
//
// The consequence worth knowing: for a visitor many hours from US Central, a
// listening bucket can be labeled "Yesterday" while holding a track whose local
// time reads as today. The bucket boundary is Cailin's midnight and cannot be
// recomputed from the aggregates the Worker sends (the heatmap carries per-day
// counts only, not timestamps).

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
