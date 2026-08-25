import { describe, expect, it } from 'vitest'
import { aggregate, findMilestone } from '../worker-listening/src/aggregate'
import { parsePeriod } from '../worker-listening/src/periods'

// One pass fills every counter, so the risk is two counters disagreeing about the same play.

const OFFSET = -18000 // US Central, matching TZ_OFFSET_SECONDS

/** Unix seconds for a local wall-clock time in the archive's timezone. */
const at = (iso: string) => Math.floor(new Date(`${iso}Z`).getTime() / 1000) - OFFSET

const scrobble = (iso: string, track: string, artist: string, album: string | null = 'Album') => ({
  uts: at(iso),
  track,
  artist,
  album,
  mbid: null,
  image: null,
})

const week = parsePeriod('w', '2026-W32', OFFSET)!
// A moment inside the week, so the period reads as complete.
const NOW = week.end + 60

function run(rows: ReturnType<typeof scrobble>[], playsBefore = 0, previous = null) {
  return aggregate({
    rows: [...rows].sort((a, b) => a.uts - b.uts),
    period: week,
    offset: OFFSET,
    now: NOW,
    playsBefore,
    previous,
  })
}

describe('totals and leaderboards', () => {
  const rows = [
    scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
    scrobble('2026-08-03T09:05:00', 'A', 'Alpha'),
    scrobble('2026-08-03T09:10:00', 'B', 'Alpha'),
    scrobble('2026-08-04T22:00:00', 'C', 'Beta'),
  ]

  it('counts plays, not distinct entities', () => {
    const s = run(rows)
    expect(s.scrobbles).toBe(4)
    expect(s.artists).toBe(2)
    expect(s.tracks).toBe(3)
  })

  it('ranks by play count and reports share', () => {
    const s = run(rows)
    expect(s.top.artists[0]).toMatchObject({ name: 'Alpha', count: 3 })
    expect(s.top.artists[0].share).toBe(75)
    expect(s.top.tracks[0]).toMatchObject({ track: 'A', artist: 'Alpha', count: 2 })
  })

  it('separates tracks with the same title by different artists', () => {
    const s = run([
      scrobble('2026-08-03T09:00:00', 'Alive', 'Alpha'),
      scrobble('2026-08-03T09:05:00', 'Alive', 'Beta'),
    ])
    expect(s.tracks).toBe(2)
    expect(s.top.tracks).toHaveLength(2)
  })

  it('leaves albums out when the scrobble has none', () => {
    const s = run([scrobble('2026-08-03T09:00:00', 'A', 'Alpha', null)])
    expect(s.albums).toBe(0)
    expect(s.top.albums).toHaveLength(0)
  })
})

describe('when the listening happened', () => {
  it('buckets into local hours and Monday-first weekdays', () => {
    // 2026-08-03 is a Monday.
    const s = run([
      scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
      scrobble('2026-08-03T09:30:00', 'B', 'Alpha'),
      scrobble('2026-08-09T23:00:00', 'C', 'Beta'), // Sunday
    ])
    expect(s.clock[9]).toBe(2)
    expect(s.clock[23]).toBe(1)
    expect(s.weekdays[0]).toBe(2) // Monday
    expect(s.weekdays[6]).toBe(1) // Sunday
    expect(s.peakHour).toBe(9)
    expect(s.peakWeekday).toBe(0)
  })

  it('keeps the 168-cell grid consistent with the two histograms', () => {
    const s = run([
      scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
      scrobble('2026-08-04T09:00:00', 'B', 'Alpha'),
      scrobble('2026-08-09T02:00:00', 'C', 'Beta'),
    ])
    const gridTotal = s.grid.reduce((a, b) => a + b, 0)
    expect(gridTotal).toBe(s.scrobbles)
    expect(s.clock.reduce((a, b) => a + b, 0)).toBe(s.scrobbles)
    expect(s.weekdays.reduce((a, b) => a + b, 0)).toBe(s.scrobbles)
    // Monday 09:00 sits at weekday 0, hour 9.
    expect(s.grid[0 * 24 + 9]).toBe(1)
    // Sunday 02:00 sits at weekday 6, hour 2.
    expect(s.grid[6 * 24 + 2]).toBe(1)
  })

  it('computes weekend and late-night shares', () => {
    const s = run([
      scrobble('2026-08-03T12:00:00', 'A', 'Alpha'), // Mon
      scrobble('2026-08-08T12:00:00', 'B', 'Alpha'), // Sat
      scrobble('2026-08-09T01:00:00', 'C', 'Beta'), // Sun, late night
      scrobble('2026-08-09T03:00:00', 'D', 'Beta'), // Sun, late night
    ])
    expect(s.weekendShare).toBe(75)
    expect(s.lateNightShare).toBe(50)
  })
})

describe('sessions, binges and album listens', () => {
  it('splits sessions on a gap over 30 minutes', () => {
    const s = run([
      scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
      scrobble('2026-08-03T09:20:00', 'B', 'Alpha'),
      // 40-minute gap starts a second session.
      scrobble('2026-08-03T10:00:00', 'C', 'Alpha'),
    ])
    expect(s.sessions.count).toBe(2)
    expect(s.sessions.longest?.tracks).toBe(2)
  })

  it('does not split a session on a gap of exactly the threshold', () => {
    const s = run([
      scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
      scrobble('2026-08-03T09:30:00', 'B', 'Alpha'),
    ])
    expect(s.sessions.count).toBe(1)
  })

  it('finds a run of one artist only once it is long enough', () => {
    const four = ['A', 'B', 'C', 'D'].map((t, i) =>
      scrobble(`2026-08-03T09:0${i}:00`, t, 'Alpha'),
    )
    expect(run(four).binges).toHaveLength(0)

    const five = [...four, scrobble('2026-08-03T09:04:00', 'E', 'Alpha')]
    expect(run(five).binges[0]).toMatchObject({ artist: 'Alpha', tracks: 5 })
  })

  it('counts an album listen by distinct tracks, not repeats of one', () => {
    // Six plays of the same song is not an album listen.
    const looped = Array.from({ length: 6 }, (_, i) =>
      scrobble(`2026-08-03T09:0${i}:00`, 'A', 'Alpha', 'Record'),
    )
    expect(run(looped).albumListens).toHaveLength(0)

    // Six different songs off one record is.
    const real = ['A', 'B', 'C', 'D', 'E', 'F'].map((t, i) =>
      scrobble(`2026-08-03T09:0${i}:00`, t, 'Alpha', 'Record'),
    )
    expect(run(real).albumListens[0]).toMatchObject({ album: 'Record', distinct: 6 })
  })
})

describe('streaks', () => {
  it('counts consecutive active days and the longest silence', () => {
    const s = run([
      scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
      scrobble('2026-08-04T09:00:00', 'B', 'Alpha'),
      scrobble('2026-08-05T09:00:00', 'C', 'Alpha'),
      // Thursday and Friday silent.
      scrobble('2026-08-08T09:00:00', 'D', 'Beta'),
    ])
    expect(s.activeDays).toBe(4)
    expect(s.streaks.longest).toBe(3)
    expect(s.streaks.longestSilence).toBe(2)
    expect(s.silentDays).toBe(3) // Thu, Fri, Sun
  })
})

describe('loyalty', () => {
  it('measures repetition and concentration', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => scrobble(`2026-08-03T09:0${i}:00`, 'A', 'Alpha')),
      scrobble('2026-08-04T09:00:00', 'B', 'Beta'),
      scrobble('2026-08-05T09:00:00', 'C', 'Gamma'),
    ]
    const s = run(rows)
    // Rounded to 2dp on the way into the blob, to keep it small.
    expect(s.loyalty.repeatRate).toBe(3.33)
    expect(s.loyalty.top10Share).toBe(100)
    // Heavily concentrated on one artist, so it "feels like" very few.
    expect(s.loyalty.effectiveArtists).toBeLessThanOrEqual(2)
  })

  it('finds the most repeated track on a single day', () => {
    const s = run([
      ...Array.from({ length: 4 }, (_, i) => scrobble(`2026-08-03T09:0${i}:00`, 'A', 'Alpha')),
      // Same track on another day should not merge into the same total.
      scrobble('2026-08-04T09:00:00', 'A', 'Alpha'),
    ])
    expect(s.loyalty.obsession).toMatchObject({ track: 'A', artist: 'Alpha', count: 4 })
    expect(s.loyalty.obsession?.date).toBe('2026-08-03')
  })
})

describe('milestones', () => {
  it('numbers scrobbles continuing from the archive total', () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      scrobble(`2026-08-03T09:0${i}:00`, `T${i}`, 'Alpha'),
    )
    // Starting at 4,999 means only the first row (5,000) crosses a milestone.
    const s = run(rows, 4_998)
    expect(s.milestones).toHaveLength(1)
    expect(s.milestones[0]).toMatchObject({ n: 5_000, track: 'T1' })
  })

  it('reports none when the period crosses no milestone', () => {
    expect(run([scrobble('2026-08-03T09:00:00', 'A', 'Alpha')], 10).milestones).toHaveLength(0)
  })

  it('treats the very first scrobble as milestone 1', () => {
    // Only the period that actually contains the archive's opening play.
    const first = run(
      [
        scrobble('2026-08-03T09:00:00', 'Opener', 'Alpha'),
        scrobble('2026-08-03T09:05:00', 'Second', 'Alpha'),
      ],
      0,
    )
    expect(first.milestones).toHaveLength(1)
    expect(first.milestones[0]).toMatchObject({ n: 1, track: 'Opener' })

    // Any later period starts past it and reports nothing.
    expect(run([scrobble('2026-08-03T09:00:00', 'A', 'Alpha')], 500).milestones).toHaveLength(0)
  })
})

// The single-day version /timeline's permalink reads — same rule as above, own entry point.
describe('findMilestone', () => {
  it('finds the one round-number scrobble in a day', () => {
    const rows = [scrobble('2026-08-03T09:00:00', 'A', 'Alpha'), scrobble('2026-08-03T09:05:00', 'B', 'Beta')]
    expect(findMilestone(rows, 4_998)).toMatchObject({ n: 5_000, track: 'B' })
  })

  it('is null when the day crosses no milestone', () => {
    expect(findMilestone([scrobble('2026-08-03T09:00:00', 'A', 'Alpha')], 10)).toBeNull()
  })

  it('treats the very first scrobble ever as milestone 1', () => {
    const first = scrobble('2026-08-03T09:00:00', 'Opener', 'Alpha')
    expect(findMilestone([first], 0)).toMatchObject({ n: 1, track: 'Opener' })
  })
})

describe('comparison against the previous period', () => {
  const previous = run([
    scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
    scrobble('2026-08-03T09:05:00', 'B', 'Alpha'),
    scrobble('2026-08-03T09:10:00', 'C', 'Gone'),
    scrobble('2026-08-03T09:15:00', 'D', 'Gone'),
  ])

  it('reports rank movement and new entries', () => {
    const s = run(
      [
        scrobble('2026-08-03T09:00:00', 'X', 'Newcomer'),
        scrobble('2026-08-03T09:05:00', 'Y', 'Newcomer'),
        scrobble('2026-08-03T09:10:00', 'Z', 'Newcomer'),
        scrobble('2026-08-03T09:15:00', 'A', 'Alpha'),
      ],
      0,
      previous as never,
    )
    expect(s.top.artists[0]).toMatchObject({ name: 'Newcomer', prevRank: null })
    // Alpha was first last period and is second now.
    expect(s.top.artists[1]).toMatchObject({ name: 'Alpha', prevRank: 1 })
  })

  it('lists artists that dropped off entirely', () => {
    const s = run([scrobble('2026-08-03T09:00:00', 'A', 'Alpha')], 0, previous as never)
    expect(s.abandoned).toContain('Gone')
    expect(s.abandoned).not.toContain('Alpha')
  })

  it('computes percentage deltas', () => {
    const s = run(
      [
        scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
        scrobble('2026-08-03T09:05:00', 'B', 'Alpha'),
      ],
      0,
      previous as never,
    )
    // 2 against the previous 4.
    expect(s.delta.scrobbles).toBe(-50)
  })
})

describe('empty periods', () => {
  it('produces a coherent zeroed blob rather than NaN', () => {
    const s = run([])
    expect(s.scrobbles).toBe(0)
    expect(s.artists).toBe(0)
    expect(s.perDay).toBe(0)
    expect(s.peakHour).toBeNull()
    expect(s.busiestDay).toBeNull()
    expect(s.loyalty.obsession).toBeNull()
    expect(s.first).toBeNull()
    expect(s.clock).toHaveLength(24)
    expect(s.grid).toHaveLength(168)
    expect(JSON.stringify(s)).not.toContain('null,null,null') // no NaN leakage
    expect(Number.isFinite(s.loyalty.repeatRate)).toBe(true)
  })
})

describe('the trend series', () => {
  it('gives a week one slot per day, including silent ones', () => {
    const s = run([scrobble('2026-08-03T09:00:00', 'A', 'Alpha')])
    expect(s.series).toHaveLength(7)
    expect(s.series[0]).toMatchObject({ label: 'Mon', count: 1 })
    expect(s.series.reduce((sum, p) => sum + p.count, 0)).toBe(s.scrobbles)
  })

  it('gives a year twelve slots regardless of activity', () => {
    const year = parsePeriod('y', '2026', OFFSET)!
    const s = aggregate({
      rows: [scrobble('2026-03-15T09:00:00', 'A', 'Alpha')],
      period: year,
      offset: OFFSET,
      now: year.end + 60,
      playsBefore: 0,
      previous: null,
    })
    expect(s.series).toHaveLength(12)
    expect(s.series[2]).toMatchObject({ label: 'Mar', count: 1 })
    expect(s.series[0].count).toBe(0)
  })
})

describe('chart movement vs genuinely new', () => {
  // "First time I ever heard this" and "wasn't on last period's chart" are different questions.
  const previous = run([
    scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
    scrobble('2026-08-03T09:05:00', 'B', 'Beta'),
  ])

  it('leaves isNew unset for the aggregator to have the caller fill in', () => {
    // aggregate() has no access to first_uts; period.ts sets this from D1.
    const s = run([scrobble('2026-08-03T09:00:00', 'A', 'Alpha')], 0, previous as never)
    expect(s.top.artists[0].isNew).toBeUndefined()
  })

  it('reports prevRank as chart position only, never as history', () => {
    const s = run(
      [
        scrobble('2026-08-03T09:00:00', 'X', 'Newcomer'),
        scrobble('2026-08-03T09:05:00', 'A', 'Alpha'),
      ],
      0,
      previous as never,
    )
    const alpha = s.top.artists.find((a) => a.name === 'Alpha')!
    const newcomer = s.top.artists.find((a) => a.name === 'Newcomer')!
    // Charting last period says nothing about whether they'd ever been played before.
    expect(alpha.prevRank).toBe(1)
    expect(newcomer.prevRank).toBeNull()
  })
})
