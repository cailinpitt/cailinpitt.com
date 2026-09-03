import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatDayStamp } from '../lib/datetime'
import { duration, kindIcon, summary, type ActivityNow } from '../lib/moving'

// Compact last-activity strip, counterpart to WatchingBar. Client-fetched
// from /now.json; renders nothing until it has data, so an API hiccup just
// leaves the page clean. No polling — syncs once a day. Shows the kind's
// mark instead of cover art, since a blank image slot would read as a load
// failure rather than "nothing to show".
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

  // Distance is already in the headline when there is one, so the second
  // line carries the time instead of repeating it.
  const secondary = activity.distanceMi > 0 ? duration(activity.movingTime) : null
  const moved = formatDayStamp(activity.startDate)

  return (
    <div className="now-bar">
      <Link className="now-bar-main" to="/moving" aria-label="Moving">
        <span className="now-bar-art moving-bar-mark" aria-hidden="true">
          {kindIcon(activity.kind)}
        </span>
        <span className="now-bar-text">
          <span className="now-bar-label">Last moved{moved ? ` · ${moved}` : ''}</span>
          <span className="now-bar-track">
            <span className="now-bar-title">{summary(activity)}</span>
            {secondary && <span className="now-bar-artist">{secondary}</span>}
          </span>
        </span>
      </Link>
    </div>
  )
}
