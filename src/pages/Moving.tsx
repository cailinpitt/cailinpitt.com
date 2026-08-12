import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Seo } from '../components/Seo'
import { CurlHint } from '../components/CurlHint'
import { StatTile } from '../components/ListeningBits'
import { MovingRow } from '../components/MovingBits'
import { fetchDuringCounts } from '../lib/listening'
import { pageSchema } from '../lib/structuredData'
import {
  byDate,
  fetchMoving,
  fetchOlderActivities,
  longDate,
  soundtrackWindow,
  type Activity,
  type MovingBundle,
} from '../lib/moving'

const DESCRIPTION = 'Bike rides and lifting sessions Cailin Pitt has logged.'

export function Component() {
  const [bundle, setBundle] = useState<MovingBundle | null>(null)
  const [error, setError] = useState(false)

  // No polling: this syncs once a day, so nothing changes while the page is open.
  useEffect(() => {
    const controller = new AbortController()
    fetchMoving(controller.signal)
      .then(setBundle)
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(true)
      })
    return () => controller.abort()
  }, [])

  return (
    <div className="moving">
      <Seo
        title="Moving"
        description={DESCRIPTION}
        path="/moving"
        jsonLd={pageSchema({
          path: '/moving',
          title: 'Moving',
          description: DESCRIPTION,
          type: 'CollectionPage',
        })}
      />

      <h1>Moving</h1>
      <p className="lead">Workouts, logged as they happen.</p>
      <CurlHint command="curl moving.cailinpitt.com" />

      {error && !bundle ? (
        <p className="moving-error">Could not load activity data right now. Try again later.</p>
      ) : !bundle ? (
        <MovingSkeleton />
      ) : (
        <>
          <section className="moving-stats" aria-labelledby="moving-stats-heading">
            <h2 id="moving-stats-heading" className="visually-hidden">
              Totals
            </h2>
            <dl className="stat-tiles">
              <StatTile label="Activities" value={bundle.counts.activities} />
              <StatTile label="Miles" value={Math.round(bundle.counts.distanceMi)} />
              <StatTile label="Rides" value={bundle.counts.rides} />
              <StatTile label="Lifts" value={bundle.counts.lifts} />
            </dl>
          </section>

          <MovingYear counts={bundle.counts} />

          <MovingLog
            initial={bundle.activities}
            initialCursor={bundle.nextCursor}
            total={bundle.counts.activities}
          />
        </>
      )}
    </div>
  )
}

// ---- this year --------------------------------------------------------------

/**
 * Renders nothing when the field is absent, the same rule /listening's "this
 * year" section follows: an older Worker or a cron that hasn't recomputed the
 * yearly totals yet shouldn't show a broken tile.
 */
function MovingYear({ counts }: { counts: MovingBundle['counts'] }) {
  if (counts.bikeMilesThisYear == null) return null
  const year = new Date().getFullYear()

  return (
    <section className="moving-year" aria-labelledby="moving-year-heading">
      <h2 id="moving-year-heading" className="eyebrow">
        {year} so far
      </h2>
      <dl className="stat-tiles is-compact">
        <StatTile label="Bike miles" value={Math.round(counts.bikeMilesThisYear)} />
        <StatTile label="Rides" value={counts.ridesThisYear} />
        <StatTile label="Lifts" value={counts.liftsThisYear} />
      </dl>
    </section>
  )
}

// ---- the log --------------------------------------------------------------

function MovingLog({
  initial,
  initialCursor,
  total,
}: {
  initial: Activity[]
  initialCursor: string | null
  total: number
}) {
  const [items, setItems] = useState(initial)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  const loadMore = useCallback(async () => {
    if (cursor == null || loading) return
    setLoading(true)
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const page = await fetchOlderActivities(cursor, 30, controller.signal)
      setItems((prev) => {
        // The cursor is exclusive, but dedupe anyway — something logged between
        // two requests could otherwise land on both pages.
        const seen = new Set(prev.map((activity) => activity.id))
        return [...prev, ...page.activities.filter((activity) => !seen.has(activity.id))]
      })
      setCursor(page.nextCursor)
    } catch (err) {
      // Stop offering the button rather than looping on a broken endpoint.
      if ((err as Error)?.name !== 'AbortError') setCursor(null)
    } finally {
      setLoading(false)
    }
  }, [cursor, loading])

  const days = useMemo(() => byDate(items), [items])
  const trackCounts = useTrackCounts(items)

  if (!items.length) {
    return <p className="moving-empty">Nothing logged yet.</p>
  }

  return (
    <section className="moving-log" aria-labelledby="moving-log-heading">
      <h2 id="moving-log-heading" className="eyebrow">
        Log
      </h2>
      {days.map(({ date, activities }) => (
        <div className="moving-day" key={date}>
          <div className="moving-day-head">
            <h3>{longDate(date)}</h3>
            <span className="moving-day-count">
              {activities.length === 1 ? '1 activity' : `${activities.length} activities`}
            </span>
          </div>
          <ul className="moving-list">
            {activities.map((activity) => (
              <MovingRow
                key={activity.id}
                activity={activity}
                trackCount={trackCounts.get(activity.id) ?? -1}
              />
            ))}
          </ul>
        </div>
      ))}

      {cursor != null && (
        <>
          <p className="load-progress">
            Showing {items.length} of {total}
          </p>
          <button className="load-more" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load older activities'}
          </button>
        </>
      )}
    </section>
  )
}

/**
 * How many tracks were playing during each loaded activity, in one request.
 *
 * Batched deliberately: the alternative is asking per row, which is thirty
 * requests for a page nobody may interact with. Re-runs when the list grows,
 * asking only about the activities it hasn't already covered.
 *
 * Failure is silent — the map stays empty, every row reports "unknown", and the
 * expanders simply all show. That degrades to the previous behavior rather than
 * to a broken page.
 */
function useTrackCounts(activities: Activity[]): Map<string, number> {
  const [counts, setCounts] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    // Same span the expander will ask for, so the count and the list agree.
    const pending = activities
      .map((a) => ({ activity: a, span: soundtrackWindow(a) }))
      .filter((p) => p.span !== null && !counts.has(p.activity.id))
    if (!pending.length) return

    const controller = new AbortController()
    let active = true
    // The endpoint caps the windows it answers for in one call (D1 allows ~50
    // statements per invocation, and this is one per window).
    const batch = pending.slice(0, 30)
    void fetchDuringCounts(
      batch.map((p) => p.span!),
      controller.signal,
    ).then((result) => {
      if (!active || !result.length) return
      setCounts((prev) => {
        const next = new Map(prev)
        batch.forEach((p, i) => next.set(p.activity.id, result[i] ?? 0))
        return next
      })
    })

    return () => {
      active = false
      controller.abort()
    }
    // `counts` is read inside but must not retrigger this: it is what the effect
    // writes. Keying on the activity list alone is what stops the loop.
  }, [activities])

  return counts
}

// ---- loading state --------------------------------------------------------

function MovingSkeleton() {
  return (
    <div className="moving-skeleton" aria-hidden="true">
      <div className="sk-tiles">
        <div className="sk-tile" />
        <div className="sk-tile" />
        <div className="sk-tile" />
        <div className="sk-tile" />
      </div>
      <div className="sk-block" />
      <div className="sk-card" />
      <div className="sk-card" />
    </div>
  )
}
