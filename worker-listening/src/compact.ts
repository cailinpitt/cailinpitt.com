// Folding a daily log down to what /timeline reads.
//
// Kept in its own module, and deliberately free of Workers types: this is the
// one piece of the listening Worker the site's own test suite runs directly
// (tests/listening-compact.test.ts), and stats.ts can't be imported from there
// because it names D1Database. Same arrangement as worker-guestbook/validate.ts.
//
// The input is described structurally rather than imported as DayLog, so this
// file depends on nothing — a DayLog satisfies it, and so does a test fixture.

/**
 * A day with the track list folded away.
 *
 * /timeline shows a count and the day's most-played artist and renders no
 * individual track, but the full logs are ~93% of the bundle it used to read:
 * ten days is ~735 track objects against the ~40 bytes it keeps.
 */
export interface CompactDay {
  date: string
  count: number
  topArtist: string | null
}

interface DayLike {
  date: string
  count: number
  tracks: { artist: string }[]
}

/**
 * The most-played artist in a day, or null for a day carrying no tracks.
 *
 * Ties go to whoever appears first. Arbitrary, but stable for a given day, so
 * the label doesn't flicker between two artists as the day's tail is merged in.
 */
function topArtist(day: DayLike): string | null {
  const counts = new Map<string, number>()
  for (const track of day.tracks) counts.set(track.artist, (counts.get(track.artist) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [artist, count] of counts) {
    if (count > bestCount) {
      best = artist
      bestCount = count
    }
  }
  return best
}

/**
 * Project day logs down to what /timeline reads. Pure — no KV, no D1.
 *
 * `count` is carried through rather than recomputed from `tracks`: it is the
 * day's real total, while the track list can be a capped tail of it.
 */
export const compactDays = (days: DayLike[]): CompactDay[] =>
  days.map((day) => ({ date: day.date, count: day.count, topArtist: topArtist(day) }))
