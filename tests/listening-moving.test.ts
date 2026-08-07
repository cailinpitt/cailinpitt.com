import { describe, expect, it } from 'vitest'
import { aggregate } from '../worker-listening/src/aggregate'
import { parsePeriod } from '../worker-listening/src/periods'

// The crossover is a merge over two ascending lists, and the boundary cases are
// where a merge goes wrong: a play exactly on a window's edge, a play between
// two activities, windows that arrive out of order.

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

const window_ = (id: string, kind: string, iso: string, minutes: number) => ({
  id,
  kind,
  startedAt: at(iso),
  elapsedTime: minutes * 60,
})

function run(
  rows: ReturnType<typeof scrobble>[],
  windows: ReturnType<typeof window_>[] = [],
) {
  return aggregate({
    rows: [...rows].sort((a, b) => a.uts - b.uts),
    period: week,
    offset: OFFSET,
    now: week.end + 60,
    playsBefore: 0,
    previous: null,
    windows,
  })
}

describe('the moving crossover', () => {
  it('counts only plays inside an activity', () => {
    const s = run(
      [
        scrobble('2026-08-03T08:00:00', 'Before', 'Alpha'),
        scrobble('2026-08-03T09:10:00', 'During', 'Beta'),
        scrobble('2026-08-03T09:20:00', 'During2', 'Beta'),
        scrobble('2026-08-03T11:00:00', 'After', 'Gamma'),
      ],
      [window_('a1', 'ride', '2026-08-03T09:00:00', 30)],
    )
    expect(s.moving.plays).toBe(2)
    expect(s.moving.activities).toBe(1)
    expect(s.moving.share).toBe(50)
    expect(s.moving.topArtists[0]).toEqual({ name: 'Beta', count: 2 })
  })

  it('includes a play exactly at the start and excludes one exactly at the end', () => {
    // Half-open [start, start+elapsed), matching how the windows are queried.
    const s = run(
      [
        scrobble('2026-08-03T09:00:00', 'AtStart', 'Alpha'),
        scrobble('2026-08-03T09:30:00', 'AtEnd', 'Beta'),
      ],
      [window_('a1', 'ride', '2026-08-03T09:00:00', 30)],
    )
    expect(s.moving.plays).toBe(1)
    expect(s.moving.topArtists[0].name).toBe('Alpha')
  })

  it('walks several activities in one period', () => {
    const s = run(
      [
        scrobble('2026-08-03T09:10:00', 'A', 'Alpha'),
        scrobble('2026-08-04T18:10:00', 'B', 'Beta'),
        scrobble('2026-08-05T07:10:00', 'C', 'Gamma'),
      ],
      [
        window_('a1', 'ride', '2026-08-03T09:00:00', 30),
        window_('a2', 'lift', '2026-08-04T18:00:00', 45),
        window_('a3', 'run', '2026-08-05T07:00:00', 20),
      ],
    )
    expect(s.moving.plays).toBe(3)
    expect(s.moving.activities).toBe(3)
    expect(s.moving.byKind.map((k) => k.kind).sort()).toEqual(['lift', 'ride', 'run'])
  })

  it('does not care what order the windows arrive in', () => {
    const rows = [
      scrobble('2026-08-03T09:10:00', 'A', 'Alpha'),
      scrobble('2026-08-05T07:10:00', 'C', 'Gamma'),
    ]
    const forward = run(rows, [
      window_('a1', 'ride', '2026-08-03T09:00:00', 30),
      window_('a3', 'run', '2026-08-05T07:00:00', 20),
    ])
    const backward = run(rows, [
      window_('a3', 'run', '2026-08-05T07:00:00', 20),
      window_('a1', 'ride', '2026-08-03T09:00:00', 30),
    ])
    expect(backward.moving.plays).toBe(forward.moving.plays)
    expect(backward.moving.activities).toBe(forward.moving.activities)
  })

  it('counts one activity once however many plays it holds', () => {
    const s = run(
      Array.from({ length: 8 }, (_, i) => scrobble(`2026-08-03T09:0${i}:00`, `T${i}`, 'Alpha')),
      [window_('a1', 'ride', '2026-08-03T09:00:00', 60)],
    )
    expect(s.moving.plays).toBe(8)
    expect(s.moving.activities).toBe(1)
  })

  it('is empty and harmless with no windows at all', () => {
    // The moving Worker being unreachable looks exactly like having no
    // activities, and must never break the rest of the period.
    const s = run([scrobble('2026-08-03T09:10:00', 'A', 'Alpha')])
    expect(s.moving.plays).toBe(0)
    expect(s.moving.share).toBe(0)
    expect(s.moving.activities).toBe(0)
    expect(s.moving.byKind).toEqual([])
    expect(s.moving.topArtists).toEqual([])
    expect(s.scrobbles).toBe(1)
  })

  it('handles an activity with no plays inside it', () => {
    const s = run(
      [scrobble('2026-08-03T14:00:00', 'A', 'Alpha')],
      [window_('a1', 'ride', '2026-08-03T09:00:00', 30)],
    )
    expect(s.moving.plays).toBe(0)
    expect(s.moving.activities).toBe(0)
  })

  it('leaves every other stat untouched', () => {
    const rows = [
      scrobble('2026-08-03T09:10:00', 'A', 'Alpha'),
      scrobble('2026-08-03T09:20:00', 'B', 'Alpha'),
    ]
    const without = run(rows)
    const with_ = run(rows, [window_('a1', 'ride', '2026-08-03T09:00:00', 30)])
    expect(with_.scrobbles).toBe(without.scrobbles)
    expect(with_.top.artists).toEqual(without.top.artists)
    expect(with_.clock).toEqual(without.clock)
    expect(with_.sessions.count).toBe(without.sessions.count)
  })
})
