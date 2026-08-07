import { describe, expect, it } from 'vitest'
import { aggregate } from '../worker-listening/src/aggregate'
import { parsePeriod } from '../worker-listening/src/periods'
import { countryFlag, countryName } from '../worker-listening/src/countries'

const OFFSET = -18000
const at = (iso: string) => Math.floor(new Date(`${iso}Z`).getTime() / 1000) - OFFSET
const week = parsePeriod('w', '2026-W32', OFFSET)!

const scrobble = (iso: string, track: string, artist: string) => ({
  uts: at(iso),
  track,
  artist,
  album: 'Album',
  mbid: null,
  image: null,
})

type Origin = { c: string | null; k: string | null; y: number | null }

function run(rows: ReturnType<typeof scrobble>[], originOf: Record<string, Origin> = {}) {
  return aggregate({
    rows: [...rows].sort((a, b) => a.uts - b.uts),
    period: week,
    offset: OFFSET,
    now: week.end + 60,
    playsBefore: 0,
    previous: null,
    originOf,
  })
}

describe('country display', () => {
  it('names and flags the codes that turn up', () => {
    expect(countryName('US')).toBe('United States')
    expect(countryFlag('US')).toBe('🇺🇸')
    expect(countryFlag('gb')).toBe('🇬🇧')
  })

  it('falls back to the raw code for anything unlisted', () => {
    expect(countryName('ZZ')).toBe('ZZ')
  })

  it('uses a globe for MusicBrainz pseudo-countries', () => {
    // XW and XE are "worldwide" and "Europe" — there is no flag for them.
    expect(countryFlag('XW')).toBe('🌐')
    expect(countryFlag('XE')).toBe('🌐')
    expect(countryFlag('nonsense')).toBe('🌐')
  })
})

describe('origin stats', () => {
  const rows = [
    scrobble('2026-08-03T09:00:00', 'A', 'Alpha'),
    scrobble('2026-08-03T09:05:00', 'B', 'Alpha'),
    scrobble('2026-08-03T09:10:00', 'C', 'Beta'),
    scrobble('2026-08-04T09:00:00', 'D', 'Unknown'),
  ]
  const originOf: Record<string, Origin> = {
    Alpha: { c: 'US', k: 'Group', y: 2010 },
    Beta: { c: 'GB', k: 'Person', y: 1992 },
  }

  it('reports country share of plays with a known country', () => {
    const s = run(rows, originOf)
    expect(s.origins.coverage).toBe(75)
    expect(s.origins.countries[0]).toMatchObject({ code: 'US', count: 2 })
    expect(s.origins.countries[0].share).toBeCloseTo(66.7, 1)
    expect(s.origins.countries.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(100, 0)
  })

  it('counts only groups in the era chart', () => {
    // Beta is a Person born 1992; that is a birth year, not a formation year, and
    // must not appear as a 1990s "era" entry alongside bands.
    const s = run(rows, originOf)
    expect(s.origins.decades).toHaveLength(1)
    expect(s.origins.decades[0]).toMatchObject({ decade: 2010, count: 2 })
    expect(s.origins.decades.some((d) => d.decade === 1990)).toBe(false)
  })

  it('splits bands from solo artists', () => {
    const s = run(rows, originOf)
    // Two Alpha plays (Group) against one Beta play (Person).
    expect(s.origins.groupShare).toBeCloseTo(66.7, 1)
    expect(s.origins.soloShare).toBeCloseTo(33.3, 1)
  })

  it('handles an artist with partial data', () => {
    const s = run(rows, { Alpha: { c: null, k: 'Group', y: 2010 } })
    expect(s.origins.coverage).toBe(0)
    expect(s.origins.countries).toEqual([])
    expect(s.origins.decades[0]).toMatchObject({ decade: 2010 })
    expect(s.origins.groupShare).toBe(100)
  })

  it('is empty and harmless with no origin map', () => {
    const s = run(rows)
    expect(s.origins.countries).toEqual([])
    expect(s.origins.decades).toEqual([])
    expect(s.origins.coverage).toBe(0)
    expect(s.origins.groupShare).toBe(0)
    expect(s.origins.soloShare).toBe(0)
  })

  it('orders eras oldest first', () => {
    const s = run(
      [
        scrobble('2026-08-03T09:00:00', 'A', 'Old'),
        scrobble('2026-08-03T09:05:00', 'B', 'Mid'),
        scrobble('2026-08-03T09:10:00', 'C', 'New'),
      ],
      {
        Old: { c: 'US', k: 'Group', y: 1975 },
        Mid: { c: 'US', k: 'Group', y: 2004 },
        New: { c: 'US', k: 'Group', y: 2021 },
      },
    )
    expect(s.origins.decades.map((d) => d.decade)).toEqual([1970, 2000, 2020])
  })
})
