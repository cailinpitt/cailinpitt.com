// The row for /moving. Kept out of the page file so the row and the
// pagination around it stay readable side by side, matching WatchingBits.
//
// Laid out on the same grid as /listening's scrobble rows — a leading measure
// where the timestamp sits there, then the icon, the line, and any trailing
// detail. Nothing rendered here links out or names a provider.

import { useState } from 'react'
import { fetchDuring, formatTime, type Scrobble } from '../lib/listening'
import { duration, kindIcon, measure, summary, type Activity } from '../lib/moving'

/** Cycling is the only kind where "indoor" means anything — a lift always is. */
const CYCLING = new Set(['ride', 'ebike'])

/**
 * What was playing during one activity.
 *
 * Deliberately lazy: the tracks are fetched only when someone opens the row, so
 * a page of thirty activities costs nothing extra to render. The listening API
 * answers from an index range over a couple of dozen rows and caches a finished
 * window for a day, so a second open is free.
 */
function Soundtrack({ activity }: { activity: Activity }) {
  const [tracks, setTracks] = useState<Scrobble[] | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')

  // Needs both halves of the window; an older moving Worker sends neither.
  if (!activity.startedAt || !activity.windowSeconds) return null

  const open = tracks !== null

  const toggle = async () => {
    if (open) {
      setTracks(null)
      return
    }
    setState('loading')
    try {
      const rows = await fetchDuring(
        activity.startedAt!,
        activity.startedAt! + activity.windowSeconds!,
      )
      setTracks(rows)
      setState('idle')
    } catch {
      setState('failed')
    }
  }

  return (
    <div className="moving-soundtrack">
      <button type="button" className="soundtrack-toggle" onClick={toggle} disabled={state === 'loading'}>
        {state === 'loading' ? 'Loading…' : open ? 'Hide what was playing' : '♫ What was playing'}
      </button>
      {state === 'failed' && <span className="soundtrack-note">Could not load that.</span>}
      {open && tracks.length === 0 && <span className="soundtrack-note">Nothing scrobbled.</span>}
      {open && tracks.length > 0 && (
        <ol className="soundtrack-list">
          {tracks.map((t) => (
            <li key={`${t.uts}-${t.track}`}>
              <time dateTime={new Date(t.uts * 1000).toISOString()}>{formatTime(t.uts)}</time>
              <span className="soundtrack-track">{t.track}</span>
              <span className="soundtrack-artist">{t.artist}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function MovingRow({ activity }: { activity: Activity }) {
  const climbed = CYCLING.has(activity.kind) && activity.elevationFt >= 100

  const details: string[] = []
  // Duration is already the headline when there is no distance; don't repeat it.
  if (activity.distanceMi > 0) details.push(duration(activity.movingTime))
  if (climbed) details.push(`${Math.round(activity.elevationFt).toLocaleString('en-US')} ft up`)
  if (CYCLING.has(activity.kind) && activity.trainer) details.push('indoor')

  return (
    <li className={`moving-row moving-${activity.kind}`}>
      <span className="moving-measure">{measure(activity)}</span>
      <span className="moving-icon" aria-hidden="true">
        {kindIcon(activity.kind)}
      </span>
      <span className="moving-summary">{summary(activity)}</span>
      <span className="moving-detail">{details.join(' · ')}</span>
      <Soundtrack activity={activity} />
    </li>
  )
}
