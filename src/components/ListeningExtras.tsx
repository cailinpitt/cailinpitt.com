import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchOnThisDay,
  fetchSparkline,
  formatNumber,
  type OnThisDay,
  type Sparkline,
} from '../lib/listening'

// Two homepage pieces (90-day scrobble sparkline, "on this day" line) that
// render nothing until their fetch lands and nothing if it fails — covers API
// hiccups and /sparkline.json being newer than whatever Worker is deployed.

const BAR = 2
const GAP = 1
const HEIGHT = 26

export function ListeningSparkline() {
  const [data, setData] = useState<Sparkline | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchSparkline(controller.signal)
      .then(setData)
      .catch(() => {
        /* leave it hidden */
      })
    return () => controller.abort()
  }, [])

  if (!data?.days.length) return null

  const max = Math.max(...data.days, 1)
  const total = data.days.reduce((sum, n) => sum + n, 0)
  const width = data.days.length * (BAR + GAP) - GAP

  return (
    <Link className="sparkline" to="/listening" aria-label={`${formatNumber(total)} scrobbles over the last ${data.days.length} days`}>
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        width={width}
        height={HEIGHT}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {data.days.map((count, i) => {
          // A quiet day still gets a 1px tick, so gaps read as "nothing played"
          // rather than as missing data.
          const h = count ? Math.max(1.5, (count / max) * HEIGHT) : 1
          return (
            <rect
              key={i}
              x={i * (BAR + GAP)}
              y={HEIGHT - h}
              width={BAR}
              height={h}
              className={count ? undefined : 'is-empty'}
            />
          )
        })}
      </svg>
      <span className="sparkline-caption">
        {formatNumber(total)} scrobbles · {data.days.length} days
      </span>
    </Link>
  )
}

export function OnThisDayLine() {
  const [data, setData] = useState<OnThisDay | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchOnThisDay(controller.signal)
      .then(setData)
      .catch(() => {
        /* leave it hidden */
      })
    return () => controller.abort()
  }, [])

  // Newest-first; a date with no history simply has none.
  const year = data?.years?.[0]
  if (!year) return null

  const ago = new Date().getFullYear() - year.year
  const when = ago === 1 ? 'A year ago today' : `${ago} years ago today`

  return (
    <p className="on-this-day-line">
      <Link to="/listening">
        <span className="on-this-day-when">{when}</span> · {formatNumber(year.count)} scrobbles
        {year.topArtist && <> · mostly {year.topArtist}</>}
      </Link>
    </p>
  )
}
