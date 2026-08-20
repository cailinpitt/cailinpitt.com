import { describe, expect, it } from 'vitest'
import { compactDays } from '../worker-listening/src/compact'

// /timeline needs only a count and top artist per day, so the Worker folds away the track lists before sending.

const track = (artist: string, uts = 0) => ({
  uts,
  track: 't',
  artist,
  album: 'a',
  mbid: '',
  image: '',
})

const day = (date: string, artists: string[]) => ({
  date,
  count: artists.length,
  tracks: artists.map((a, i) => track(a, i)),
})

describe('compactDays', () => {
  it('keeps the date and count, and drops the tracks', () => {
    const [out] = compactDays([day('2026-08-07', ['Charli xcx', 'Vegyn'])])
    expect(out).toEqual({ date: '2026-08-07', count: 2, topArtist: 'Charli xcx' })
    expect(out).not.toHaveProperty('tracks')
  })

  it('reports the most-played artist, not the first one', () => {
    const [out] = compactDays([day('2026-08-07', ['Vegyn', 'Charli xcx', 'Charli xcx'])])
    expect(out.topArtist).toBe('Charli xcx')
  })

  it('carries the count the day arrived with rather than recounting', () => {
    // `tracks` can be a capped tail; recomputing from it would understate a heavy day.
    const out = compactDays([{ date: '2026-08-07', count: 240, tracks: [track('Vegyn')] }])
    expect(out[0].count).toBe(240)
  })

  it('gives a day with no tracks a null artist rather than dropping the day', () => {
    // A day still needs its row: the timeline merges six other streams onto it.
    const out = compactDays([{ date: '2026-08-06', count: 0, tracks: [] }])
    expect(out).toEqual([{ date: '2026-08-06', count: 0, topArtist: null }])
  })

  it('preserves order, which is the order the page renders', () => {
    const out = compactDays([day('2026-08-07', ['A']), day('2026-08-06', ['B'])])
    expect(out.map((d) => d.date)).toEqual(['2026-08-07', '2026-08-06'])
  })
})
