// The row for /moving. Kept out of the page file so the row and the
// pagination around it stay readable side by side, matching WatchingBits.
//
// Laid out on the same grid as /listening's scrobble rows — a leading measure
// where the timestamp sits there, then the icon, the line, and any trailing
// detail. Nothing rendered here links out or names a provider.

import { useState } from 'react'
import { fetchDuring, formatTime, type Scrobble } from '../lib/listening'
import {
  duration,
  heartRate,
  kindIcon,
  measure,
  soundtrackWindow,
  summary,
  type Activity,
} from '../lib/moving'

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
function Soundtrack({ activity, count }: { activity: Activity; count: number }) {
  const [tracks, setTracks] = useState<Scrobble[] | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')

  // Needs both halves of the window; an older moving Worker sends neither.
  // `count` of 0 means the batched check found nothing in this window, so there
  // is no expander to offer — a toggle that opens onto "nothing" is worse than
  // no toggle. Counts are unknown until that fetch lands, which is why the
  // caller passes -1 rather than 0 in the meantime.
  const span = soundtrackWindow(activity)
  if (!span || count === 0) return null

  const open = tracks !== null

  const toggle = async () => {
    if (open) {
      setTracks(null)
      return
    }
    setState('loading')
    try {
      const rows = await fetchDuring(span.from, span.to)
      setTracks(rows)
      setState('idle')
    } catch {
      setState('failed')
    }
  }

  return (
    <div className="moving-soundtrack">
      <button type="button" className="soundtrack-toggle" onClick={toggle} disabled={state === 'loading'}>
        {state === 'loading'
          ? 'Loading…'
          : open
            ? 'Hide what was playing'
            : `♫ ${count > 0 ? `${count} track${count === 1 ? '' : 's'}` : 'What was playing'}`}
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

export function MovingRow({
  activity,
  trackCount = -1,
}: {
  activity: Activity
  /** -1 while the batched count is still in flight; 0 hides the expander. */
  trackCount?: number
}) {
  const climbed = CYCLING.has(activity.kind) && activity.elevationFt >= 100

  const details: string[] = []
  // Duration is already the headline when there is no distance; don't repeat it.
  if (activity.distanceMi > 0) details.push(duration(activity.movingTime))
  if (climbed) details.push(`${Math.round(activity.elevationFt).toLocaleString('en-US')} ft up`)
  if (CYCLING.has(activity.kind) && activity.trainer) details.push('indoor')
  // Rendered as markup rather than pushed into `details`: the glyph is coloured
  // and hidden from screen readers, which a joined string can't express.
  const hr = heartRate(activity)

  return (
    <li className={`moving-row moving-${activity.kind}`}>
      <span className="moving-measure">{measure(activity)}</span>
      <span className="moving-icon" aria-hidden="true">
        {kindIcon(activity.kind)}
      </span>
      <span className="moving-summary">{summary(activity)}</span>
      <span className="moving-detail">
        {details.join(' · ')}
        {hr && (
          <>
            {details.length > 0 && ' · '}
            {/* The glyph carries the meaning visually; the label carries it for
                a screen reader, which would otherwise hear "black heart suit". */}
            <span className="moving-hr-icon" aria-hidden="true">
              ♥
            </span>
            <span className="visually-hidden">average heart rate </span>
            {hr.avg}
            <span aria-hidden="true"> avg</span>
            <span className="visually-hidden"> bpm</span>
            {hr.max !== null && (
              <>
                {' · '}
                <span className="visually-hidden">maximum heart rate </span>
                {hr.max}
                <span aria-hidden="true"> max</span>
                <span className="visually-hidden"> bpm</span>
              </>
            )}
          </>
        )}
      </span>
      <Soundtrack activity={activity} count={trackCount} />
    </li>
  )
}
