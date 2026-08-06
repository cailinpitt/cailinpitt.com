import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatDayLabel } from '../lib/datetime'
import { duration, kindIcon, summary, type ActivityNow } from '../lib/moving'

/**
 * Compact last-activity strip, the counterpart to WatchingBar. Client-fetched
 * from the lightweight /now.json endpoint; renders nothing until it has data,
 * so the prerendered shell and any API hiccup just leave the page clean.
 *
 * No polling — this syncs once a day.
 *
 * Where the other bars show cover art, this shows the kind's mark: an activity
 * has no image, and a blank placeholder in that slot would read as a failure to
 * load rather than as "there is nothing to show".
 */
export function MovingBar() {
  const [now, setNow] = useState<ActivityNow | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    import('../lib/moving')
      .then(({ fetchMovingNow }) => fetchMovingNow(controller.signal))
      .catch(() => null)
      .then((data) => {
        if (data) setNow(data)
      })
    return () => controller.abort()
  }, [])

  const activity = now?.lastActivity
  if (!activity) return null

  // Distance is already in the headline when there is one, so the second line
  // carries the time instead of repeating it.
  const secondary = activity.distanceMi > 0 ? duration(activity.movingTime) : null

  return (
    <div className="now-bar">
      <Link className="now-bar-main" to="/moving" aria-label="Moving">
        <span className="now-bar-art moving-bar-mark" aria-hidden="true">
          {kindIcon(activity.kind)}
        </span>
        <span className="now-bar-text">
          {/* formatDayLabel, not the page's longDate: the chips say "Today"
              when it was today, and this one should read the same. */}
          <span className="now-bar-label">Last moved · {formatDayLabel(activity.startDate)}</span>
          <span className="now-bar-track">
            <span className="now-bar-title">{summary(activity)}</span>
            {secondary && <span className="now-bar-artist">{secondary}</span>}
          </span>
        </span>
      </Link>
    </div>
  )
}
