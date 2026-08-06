// The row for /moving. Kept out of the page file so the row and the
// pagination around it stay readable side by side, matching WatchingBits.
//
// Laid out on the same grid as /listening's scrobble rows — a leading measure
// where the timestamp sits there, then the icon, the line, and any trailing
// detail. Nothing rendered here links out or names a provider.

import { duration, kindIcon, measure, summary, type Activity } from '../lib/moving'

/** Cycling is the only kind where "indoor" means anything — a lift always is. */
const CYCLING = new Set(['ride', 'ebike'])

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
    </li>
  )
}
