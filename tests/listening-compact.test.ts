import { describe, expect, it } from 'vitest'
import { compactDays } from '../worker-listening/src/compact'

// /timeline reads a count and a top artist per day and renders no individual
// track, so the Worker folds the track lists away before sending them. The fold
// used to happen in the browser, over the full bundle; these are the rules that
// came across with it.

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
    // The bundle's `count` is the day's real total; `tracks` can be a capped
    // tail of it. Recomputing from the tracks would understate a heavy day.
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
