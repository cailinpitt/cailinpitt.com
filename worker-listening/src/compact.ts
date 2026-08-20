// Folding a daily log down to what /timeline reads. Kept free of Workers types
// (no D1Database) so tests/listening-compact.test.ts can import it directly —
// same arrangement as worker-guestbook/validate.ts. Input is described
// structurally rather than importing DayLog, so a test fixture satisfies it too.

/** /timeline shows a count and top artist, not individual tracks — full logs were ~93% of the bundle it used to read. */
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

// Ties go to whoever appears first — arbitrary but stable, so the label doesn't
// flicker as the day's tail is merged in.
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

// `count` is carried through rather than recomputed from `tracks`, since the
// track list can be a capped tail of the day's real total.
export const compactDays = (days: DayLike[]): CompactDay[] =>
  days.map((day) => ({ date: day.date, count: day.count, topArtist: topArtist(day) }))
