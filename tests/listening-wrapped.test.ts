import { describe, expect, it } from 'vitest'
import { buildCards, deriveTraits, formatHour, formatSpan, MIN_SCROBBLES } from '../src/lib/wrapped'
import type { PeriodStats } from '../src/lib/listening'

// The narrative editorializes, so the risk is stating something the data doesn't support. These pin the restraint.

/** A blob with everything present; tests override just the field under test. */
function stats(over: Partial<PeriodStats> = {}): PeriodStats {
  return {
    kind: 'y',
    key: '2026',
    label: '2026',
    start: 0,
    end: 0,
    complete: true,
    computedAt: 0,
    scrobbles: 10_000,
    artists: 500,
    albums: 800,
    tracks: 3_000,
    perDay: 30,
    activeDays: 300,
    silentDays: 65,
    top: {
      artists: [{ name: 'Alpha', count: 900, share: 9, image: null, prevRank: null }],
      albums: [{ album: 'Record', artist: 'Alpha', count: 300, share: 3, image: null, prevRank: null }],
      tracks: [{ track: 'Song', artist: 'Alpha', count: 120, share: 1.2, image: null, prevRank: null }],
    },
    clock: new Array(24).fill(10),
    weekdays: new Array(7).fill(10),
    grid: new Array(168).fill(1),
    peakHour: 17,
    quietestHour: 4,
    peakWeekday: 1,
    weekendShare: 28,
    lateNightShare: 2,
    series: [],
    busiestDay: { date: '2026-03-04', count: 155 },
    busiestHour: { hour: 17, count: 900 },
    streaks: { longest: 9, longestSilence: 3 },
    sessions: { count: 900, avgTracks: 11, longest: { start: 0, end: 0, tracks: 44, topArtist: 'Alpha' } },
    binges: [],
    albumListens: [],
    loyalty: { repeatRate: 2.1, top10Share: 35, effectiveArtists: 90, obsession: null },
    curios: { remix: 0, live: 0, acoustic: 0, collab: 0, longestTitle: null },
    genres: [{ name: 'indie rock', count: 2000, share: 30 }],
    newGenres: [],
    genreDiversity: 6,
    genreSeries: [],
    genreCoverage: 90,
    origins: {
      countries: [
        { code: 'US', count: 5000, share: 60 },
        { code: 'GB', count: 2000, share: 24 },
      ],
      decades: [],
      groupShare: 70,
      soloShare: 30,
      coverage: 85,
    },
    listening: { seconds: 2_721_600, coverage: 80, avgTrackSeconds: 210, topByTime: [], longest: null },
    moving: { plays: 0, share: 0, activities: 0, byKind: [], topArtists: [], topTracks: [] },
    milestones: [],
    first: null,
    last: null,
    discovery: { artists: 200, albums: 300, tracks: 900, rate: 30, newArtists: [], returning: [] },
    abandoned: [],
    delta: { scrobbles: null, artists: null, tracks: null, perDay: null },
    ...over,
  }
}

describe('formatting', () => {
  it('names hours the way people say them', () => {
    expect(formatHour(0)).toBe('midnight')
    expect(formatHour(12)).toBe('noon')
    expect(formatHour(9)).toBe('9am')
    expect(formatHour(17)).toBe('5pm')
  })

  it('scales the span to something readable', () => {
    expect(formatSpan(1800)).toBe('30 minutes')
    expect(formatSpan(7200)).toBe('2 hours')
    expect(formatSpan(2_721_600)).toBe('756 hours')
  })
})

describe('the thin-data floor', () => {
  it('produces nothing at all below the minimum', () => {
    const thin = stats({ scrobbles: MIN_SCROBBLES - 1 })
    expect(buildCards(thin)).toEqual([])
    expect(deriveTraits(thin)).toEqual([])
  })
})

describe('cards', () => {
  it('leads with the totals and includes the leaderboards', () => {
    const cards = buildCards(stats())
    expect(cards[0].kicker).toBe('I played')
    expect(cards[0].value).toBe('10,000 tracks')
    expect(cards.some((c) => c.value === 'Alpha')).toBe(true)
    expect(cards.some((c) => c.value === 'Song')).toBe(true)
  })

  it('omits listening time when durations are unknown', () => {
    const cards = buildCards(
      stats({ listening: { seconds: 0, coverage: 0, avgTrackSeconds: 0, topByTime: [], longest: null } }),
    )
    expect(cards.some((c) => c.kicker === 'That is')).toBe(false)
  })

  it('refuses to name a top genre on thin coverage', () => {
    // 30% classified is not a fact about the year, however confident the share looks.
    const cards = buildCards(stats({ genreCoverage: 30 }))
    expect(cards.some((c) => c.kicker === 'My sound')).toBe(false)

    const good = buildCards(stats({ genreCoverage: 90 }))
    expect(good.some((c) => c.kicker === 'My sound')).toBe(true)
  })

  it('refuses to talk about geography on thin coverage', () => {
    const cards = buildCards(stats({ origins: { ...stats().origins, coverage: 20 } }))
    expect(cards.some((c) => c.kicker === 'From')).toBe(false)
  })

  it('skips a short listening session rather than calling it a sitting', () => {
    const cards = buildCards(
      stats({ sessions: { count: 10, avgTracks: 3, longest: { start: 0, end: 0, tracks: 5, topArtist: null } } }),
    )
    expect(cards.some((c) => c.kicker === 'Longest sitting')).toBe(false)
  })

  it('survives a blob with empty leaderboards', () => {
    const cards = buildCards(stats({ top: { artists: [], albums: [], tracks: [] } }))
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.every((c) => typeof c.value === 'string' && c.value.length > 0)).toBe(true)
  })
})

describe('traits', () => {
  it('calls high discovery with low concentration an explorer', () => {
    const t = deriveTraits(
      stats({
        discovery: { ...stats().discovery, rate: 60 },
        loyalty: { ...stats().loyalty, top10Share: 25 },
      }),
    )
    expect(t.map((x) => x.label)).toContain('Explorer')
  })

  it('calls heavy concentration a loyalist', () => {
    const t = deriveTraits(stats({ loyalty: { ...stats().loyalty, top10Share: 70 } }))
    expect(t.map((x) => x.label)).toContain('Loyalist')
  })

  it('never calls the same period both explorer and loyalist', () => {
    for (const rate of [5, 20, 45, 60, 90]) {
      for (const share of [10, 30, 55, 80]) {
        const t = deriveTraits(
          stats({
            discovery: { ...stats().discovery, rate },
            loyalty: { ...stats().loyalty, top10Share: share },
          }),
        ).map((x) => x.label)
        expect(t.includes('Explorer') && t.includes('Loyalist'), `${rate}/${share}`).toBe(false)
      }
    }
  })

  it('reads the clock', () => {
    expect(deriveTraits(stats({ lateNightShare: 25 })).map((x) => x.label)).toContain('Night owl')
    expect(
      deriveTraits(stats({ lateNightShare: 1, peakHour: 8 })).map((x) => x.label),
    ).toContain('Early riser')
    expect(
      deriveTraits(stats({ lateNightShare: 1, peakHour: 22 })).map((x) => x.label),
    ).toContain('Evening listener')
  })

  it('emits at most one time-of-day trait', () => {
    const timeLabels = new Set(['Night owl', 'Early riser', 'Evening listener'])
    for (const [late, peak] of [[25, 8], [25, 22], [1, 8], [1, 22], [1, 14]] as const) {
      const hits = deriveTraits(stats({ lateNightShare: late, peakHour: peak })).filter((t) =>
        timeLabels.has(t.label),
      )
      expect(hits.length, `${late}/${peak}`).toBeLessThanOrEqual(1)
    }
  })

  it('stays quiet about genre when coverage is thin', () => {
    const t = deriveTraits(
      stats({ genreCoverage: 20, genres: [{ name: 'hardcore', count: 100, share: 80 }] }),
    )
    expect(t.some((x) => x.label.includes('devotee'))).toBe(false)
    expect(t.some((x) => x.label === 'Eclectic')).toBe(false)
  })

  it('names a devotee only on a dominant, well-covered genre', () => {
    const t = deriveTraits(
      stats({
        genreCoverage: 95,
        genreDiversity: 3,
        genres: [{ name: 'hardcore', count: 5000, share: 55 }],
      }),
    )
    expect(t.map((x) => x.label)).toContain('Hardcore devotee')
  })

  it('speaks in the first person, never addressing the reader', () => {
    // This is Cailin's data on Cailin's site; "you played" would imply otherwise.
    const all = [
      ...deriveTraits(stats({ lateNightShare: 25, weekendShare: 45 })).flatMap((t) => [t.label, t.detail]),
      ...buildCards(stats()).flatMap((c) => [c.kicker, c.value, c.detail ?? '']),
    ]
    for (const text of all) {
      expect(text, text).not.toMatch(/\byou(r|rs)?\b/i)
    }
  })

  it('always cites a number in its evidence', () => {
    for (const trait of deriveTraits(stats({ lateNightShare: 25, streaks: { longest: 30, longestSilence: 1 } }))) {
      expect(trait.detail, trait.label).toMatch(/\d/)
    }
  })
})
