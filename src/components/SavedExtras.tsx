// The stats strip and search/site filter shared by /links and /reading/articles.

import { useEffect, useState } from 'react'
import { formatNumber } from '../lib/datetime'
import { fetchSavedStats, type SavedStats } from '../lib/reading'

const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

const BAR = 6
const GAP = 2
const HEIGHT = 32

const weekLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function WeeklyBars({ stats, noun }: { stats: SavedStats; noun: string }) {
  const max = Math.max(...stats.weeks, 1)
  const width = stats.weeks.length * (BAR + GAP) - GAP
  const first = Date.parse(`${stats.firstWeek}T00:00:00Z`)
  const total = stats.weeks.reduce((sum, n) => sum + n, 0)

  return (
    <figure className="saved-weeks">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${formatNumber(total)} ${noun} saved over the last ${stats.weeks.length} weeks`}
      >
        {stats.weeks.map((count, i) => {
          // An empty week keeps a 1px tick, so it reads as "none" rather than missing.
          const h = count ? Math.max(2, (count / max) * HEIGHT) : 1
          const label = weekLabel.format(new Date(first + i * 7 * 86400_000))
          return (
            <g key={i}>
              <rect
                x={i * (BAR + GAP)}
                y={HEIGHT - h}
                width={BAR}
                height={h}
                rx={count ? 1.5 : 0}
                className={count ? undefined : 'is-empty'}
              />
              {/* Full-height hit target, so a short bar is still easy to hover. */}
              <rect x={i * (BAR + GAP) - GAP / 2} y={0} width={BAR + GAP} height={HEIGHT} className="hit">
                <title>
                  Week of {label}: {count} {count === 1 ? noun.replace(/s$/, '') : noun}
                </title>
              </rect>
            </g>
          )
        })}
      </svg>
      <figcaption>Per week, last {stats.weeks.length} weeks</figcaption>
    </figure>
  )
}

export function SavedStatsStrip({
  kind,
  site,
  onSite,
}: {
  kind: 'articles' | 'links'
  site: string
  onSite: (site: string) => void
}) {
  const [stats, setStats] = useState<SavedStats | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchSavedStats(kind, controller.signal)
      .then(setStats)
      .catch(() => {
        /* the strip is extra; leave it hidden */
      })
    return () => controller.abort()
  }, [kind])

  if (!stats?.total) return null
  const noun = kind === 'articles' ? 'articles' : 'links'

  return (
    <section className="saved-stats" aria-label={`${kind === 'articles' ? 'Article' : 'Link'} stats`}>
      <dl className="stat-tiles">
        <div className="stat-tile">
          <dt>Saved</dt>
          <dd>{formatNumber(stats.total)}</dd>
        </div>
        <div className="stat-tile">
          <dt>This year</dt>
          <dd>{formatNumber(stats.thisYear)}</dd>
        </div>
        <div className="stat-tile">
          <dt>Longest streak</dt>
          <dd>
            {stats.longestStreak} {stats.longestStreak === 1 ? 'day' : 'days'}
          </dd>
        </div>
        {stats.busiestWeekday != null && (
          <div className="stat-tile">
            <dt>Busiest on</dt>
            <dd>{WEEKDAYS[stats.busiestWeekday]}</dd>
          </div>
        )}
      </dl>

      <WeeklyBars stats={stats} noun={noun} />

      {stats.topSites.length > 0 && (
        <div className="saved-sites">
          <h2 className="saved-sites-label">Most saved from</h2>
          <ul>
            {stats.topSites.map(({ host, count }) => (
              <li key={host}>
                <button
                  type="button"
                  className={host === site ? 'is-active' : undefined}
                  aria-pressed={host === site}
                  onClick={() => onSite(host === site ? '' : host)}
                >
                  {host} <span className="saved-sites-count">{count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Search box plus the active site filter, if any. Typing is debounced before `onQ`. */
export function SavedSearch({
  q,
  site,
  noun,
  onQ,
  onSite,
}: {
  q: string
  site: string
  noun: string
  onQ: (q: string) => void
  onSite: (site: string) => void
}) {
  const [draft, setDraft] = useState(q)

  // Follow outside changes (back/forward) without clobbering what's being typed.
  useEffect(() => setDraft(q), [q])

  useEffect(() => {
    if (draft === q) return
    const timer = setTimeout(() => onQ(draft), 300)
    return () => clearTimeout(timer)
  }, [draft, q, onQ])

  return (
    <div className="saved-search">
      <input
        type="search"
        value={draft}
        placeholder={`Search ${noun}…`}
        aria-label={`Search ${noun}`}
        onChange={(e) => setDraft(e.target.value)}
      />
      {site && (
        <button type="button" className="saved-site-chip" onClick={() => onSite('')}>
          {site} <span aria-hidden="true">×</span>
          <span className="visually-hidden">(clear site filter)</span>
        </button>
      )}
    </div>
  )
}
