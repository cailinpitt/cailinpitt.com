// The row for /moving, kept out of the page file to match WatchingBits. Uses
// the same grid as /listening's scrobble rows (measure, icon, line, detail).
// Nothing rendered here links out or names a provider.

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

/** What was playing during one activity. Fetched lazily on open, so a page of thirty activities costs nothing extra; the API caches a finished window for a day. */
function Soundtrack({ activity, count }: { activity: Activity; count: number }) {
  const [tracks, setTracks] = useState<Scrobble[] | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')

  // count === 0 means the batched check found nothing, so skip the expander
  // (a toggle that opens onto "nothing" is worse than none) — hence -1 default.
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
  // Rendered separately, not joined into `details`: needs a coloured, aria-hidden glyph.
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
            {/* visually-hidden label avoids a screen reader announcing "black heart suit". */}
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
