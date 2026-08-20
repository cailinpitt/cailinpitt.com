import { describe, expect, it } from 'vitest'
import {
  CANONICAL_GENRES,
  normalizeTag,
  primaryGenre,
  tagsToGenres,
} from '../worker-listening/src/genres'
import { aggregate } from '../worker-listening/src/aggregate'
import { parsePeriod } from '../worker-listening/src/periods'

const OFFSET = -18000
const at = (iso: string) => Math.floor(new Date(`${iso}Z`).getTime() / 1000) - OFFSET
const week = parsePeriod('w', '2026-W32', OFFSET)!

const scrobble = (iso: string, track: string, artist: string, album: string | null = 'Album') => ({
  uts: at(iso),
  track,
  artist,
  album,
  mbid: null,
  image: null,
})

function run(
  rows: ReturnType<typeof scrobble>[],
  genreOf: Record<string, string> = {},
  durationOf: Record<string, number> = {},
) {
  return aggregate({
    rows: [...rows].sort((a, b) => a.uts - b.uts),
    period: week,
    offset: OFFSET,
    now: week.end + 60,
    playsBefore: 0,
    previous: null,
    genreOf,
    durationOf,
  })
}

describe('tag normalization', () => {
  it('folds subgenres into a canonical parent', () => {
    expect(normalizeTag('hardcore punk')).toBe('hardcore')
    expect(normalizeTag('nyhc')).toBe('hardcore')
    expect(normalizeTag('post-hardcore')).toBe('hardcore')
    expect(normalizeTag('midwest emo')).toBe('emo')
  })

  it('is case and whitespace insensitive', () => {
    expect(normalizeTag('  Hardcore Punk  ')).toBe('hardcore')
    expect(normalizeTag('HYPERPOP')).toBe('hyperpop')
  })

  it('drops tags that are not genres', () => {
    // The actual noise in this archive: scenes, cities, filing labels, decades.
    for (const junk of [
      'seen live',
      'favorites',
      'albums i own',
      'female vocalists',
      'Baltimore',
      '2021',
      'awesome',
      'british',
      '',
    ]) {
      expect(normalizeTag(junk), junk).toBeNull()
    }
  })

  it('never matches on substrings', () => {
    // Exact match only: these all contain a shorter genre name a substring rule would mis-file.
    expect(normalizeTag('demo')).toBeNull()
    expect(normalizeTag('poppy')).toBeNull()
    expect(normalizeTag('rocksteady')).toBeNull()
  })

  it('treats every canonical name as an alias of itself', () => {
    for (const genre of CANONICAL_GENRES) {
      expect(normalizeTag(genre), genre).toBe(genre)
    }
  })
})

describe('artist genre selection', () => {
  it("sums aliases so a split scene doesn't lose to a single stray tag", () => {
    // Turnstile's real tags: hardcore's aliases (100+61+16) beat any single other tag.
    const tags = [
      { name: 'hardcore', count: 100 },
      { name: 'hardcore punk', count: 61 },
      { name: 'punk', count: 17 },
      { name: 'post-hardcore', count: 16 },
      { name: 'alternative rock', count: 7 },
      { name: 'nyhc', count: 1 },
      { name: 'Baltimore', count: 1 },
    ]
    expect(primaryGenre(tags)).toBe('hardcore')
    expect(tagsToGenres(tags, 3)).toEqual(['hardcore', 'punk', 'alternative rock'])
  })

  it('returns null when nothing maps', () => {
    expect(primaryGenre([{ name: 'seen live', count: 100 }])).toBeNull()
    expect(primaryGenre([])).toBeNull()
  })

  it('survives a missing or nonsense weight', () => {
    expect(primaryGenre([{ name: 'shoegaze', count: NaN }])).toBe('shoegaze')
    expect(primaryGenre([{ name: 'shoegaze', count: 0 }])).toBe('shoegaze')
  })
})

describe('genre stats on a period', () => {
  const rows = [
    scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
    scrobble('2026-08-03T09:05:00', 'B', 'Alpha'),
    scrobble('2026-08-03T09:10:00', 'C', 'Beta'),
    scrobble('2026-08-04T09:00:00', 'D', 'Unknown'),
  ]
  const genreOf = { Alpha: 'hardcore', Beta: 'hyperpop' }

  it('reports share of classified plays, not of all plays', () => {
    const s = run(rows, genreOf)
    // 3 of 4 plays are classified; hardcore is 2 of those 3.
    expect(s.genreCoverage).toBe(75)
    expect(s.genres[0]).toMatchObject({ name: 'hardcore', count: 2 })
    expect(s.genres[0].share).toBeCloseTo(66.7, 1)
    // Shares sum to 100 despite a quarter of plays being unclassified.
    expect(s.genres.reduce((sum, g) => sum + g.share, 0)).toBeCloseTo(100, 0)
  })

  it('is empty and harmless with no genre map at all', () => {
    const s = run(rows)
    expect(s.genres).toEqual([])
    expect(s.genreCoverage).toBe(0)
    expect(s.genreDiversity).toBe(0)
  })

  it('builds a per-bucket series aligned with the plain trend', () => {
    const s = run(rows, genreOf)
    expect(s.genreSeries).toHaveLength(s.series.length)
    expect(s.genreSeries.map((p) => p.key)).toEqual(s.series.map((p) => p.key))
    // Monday had two hardcore and one hyperpop.
    const monday = s.genreSeries[0]
    expect(monday.genres.hardcore).toBeCloseTo(66.7, 1)
  })

  it('flags genres absent from the previous period as new', () => {
    const previous = run(
      [scrobble('2026-08-03T09:00:00', 'A', 'Alpha')],
      { Alpha: 'hardcore' },
    )
    const s = aggregate({
      rows: rows.sort((a, b) => a.uts - b.uts),
      period: week,
      offset: OFFSET,
      now: week.end + 60,
      playsBefore: 0,
      previous,
      genreOf,
    })
    expect(s.newGenres).toContain('hyperpop')
    expect(s.newGenres).not.toContain('hardcore')
  })
})

describe('listening time', () => {
  const rows = [
    scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
    scrobble('2026-08-03T09:05:00', 'B', 'Alpha'),
    scrobble('2026-08-03T09:10:00', 'C', 'Beta'),
    scrobble('2026-08-03T09:15:00', 'D', 'Beta'),
  ]
  // Matches SEP in aggregate.ts — the key separator for the duration lookup.
  const sep = ''
  const durations = {
    [`A${sep}Alpha`]: 200,
    [`B${sep}Alpha`]: 100,
    [`C${sep}Beta`]: 300,
    [`D${sep}Beta`]: 400,
  }

  it('totals durations and ranks artists by time', () => {
    const s = run(rows, {}, durations)
    expect(s.listening.seconds).toBe(1000)
    expect(s.listening.coverage).toBe(100)
    expect(s.listening.avgTrackSeconds).toBe(250)
    // Beta wins on time (700s) despite matching Alpha on play count.
    expect(s.listening.topByTime[0]).toEqual({ name: 'Beta', seconds: 700 })
    expect(s.listening.longest).toMatchObject({ track: 'D', seconds: 400 })
  })

  it('extrapolates over unknown durations rather than under-reporting', () => {
    // Only half the plays have a length; 300s measured over 50% coverage.
    const partial = { [`A${sep}Alpha`]: 200, [`C${sep}Beta`]: 100 }
    const s = run(rows, {}, partial)
    expect(s.listening.coverage).toBe(50)
    expect(s.listening.seconds).toBe(600)
    // The average stays honest — it is over measured plays only.
    expect(s.listening.avgTrackSeconds).toBe(150)
  })

  it('reports zero, not NaN, with no durations known', () => {
    const s = run(rows)
    expect(s.listening.seconds).toBe(0)
    expect(s.listening.coverage).toBe(0)
    expect(s.listening.avgTrackSeconds).toBe(0)
    expect(s.listening.longest).toBeNull()
    expect(s.listening.topByTime).toEqual([])
  })
})
