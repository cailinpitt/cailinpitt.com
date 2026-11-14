import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Seo } from '../components/Seo'
import { CurlHint } from '../components/CurlHint'
import { MovingRow } from '../components/MovingBits'
import { fetchDuringCounts } from '../lib/listening'
import { pageSchema } from '../lib/structuredData'
import {
  byDate,
  drivingSaved,
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
      <p>Workouts, logged as they happen.</p>
      <CurlHint command="curl moving.cailinpitt.com" />

      {error && !bundle ? (
        <p className="moving-error">Could not load activity data right now. Try again later.</p>
      ) : !bundle ? (
        <MovingSkeleton />
      ) : (
        <>
          <MovingSummary bundle={bundle} />

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

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
// Non-breaking inside each figure, so a narrow card wraps at the dots instead.
const plural = (n: number, word: string) => `${fmt(n)}\u00a0${word}${Math.round(n) === 1 ? '' : 's'}`

interface Sport {
  key: string
  icon: string
  name: string
  total: string
  unit?: string
  detail?: string
  year?: string
  note?: string
}

function sports(bundle: MovingBundle): Sport[] {
  const c = bundle.counts
  const list: Sport[] = [
    {
      key: 'bike',
      icon: '🚲',
      name: 'Bike',
      total: fmt(c.bikeMiles ?? c.distanceMi),
      unit: 'mi',
      detail: plural(c.rides, 'ride'),
      year: `${fmt(c.bikeMilesThisYear)}\u00a0mi · ${plural(c.ridesThisYear, 'ride')}`,
    },
  ]
  if (c.runs) {
    list.push({
      key: 'run',
      icon: '🏃',
      name: 'Run',
      total: fmt(c.runMiles ?? 0),
      unit: 'mi',
      detail: plural(c.runs, 'run'),
      year: `${fmt(c.runMilesThisYear ?? 0)}\u00a0mi · ${plural(c.runsThisYear ?? 0, 'run')}`,
    })
  }
  list.push({
    key: 'lift',
    icon: '🏋️',
    name: 'Lift',
    total: fmt(c.lifts),
    detail: c.lifts === 1 ? 'session' : 'sessions',
    year: plural(c.liftsThisYear, 'session'),
  })
  if (bundle.scooter) {
    const saved = drivingSaved(bundle.scooter.odometerMi)
    list.push({
      key: 'scooter',
      icon: '🛴',
      name: 'Scooter',
      total: fmt(bundle.scooter.odometerMi),
      unit: 'mi',
      detail: 'lifetime',
      note: `Saved $${fmt(saved.dollars)} in gas, ${fmt(saved.co2Lb)} lb CO₂`,
    })
  }
  return list
}

function MovingSummary({ bundle }: { bundle: MovingBundle }) {
  const year = new Date().getFullYear()
  const { activities, activitiesThisYear } = bundle.counts
  return (
    <section className="moving-totals" aria-labelledby="moving-totals-heading">
      <h2 id="moving-totals-heading" className="moving-headline">
        <strong>{fmt(activities)}</strong> activities
        <span className="moving-headline-year">
          {' · '}
          <strong>{fmt(activitiesThisYear)}</strong> in {year}
        </span>
      </h2>
      <ul className="sport-cards">
        {sports(bundle).map((sport) => (
          <li key={sport.key} className={`sport-card sport-${sport.key}`}>
            <h3 className="sport-name">
              <span aria-hidden="true">{sport.icon}</span> {sport.name}
            </h3>
            <p className="sport-total">
              {sport.total}
              {sport.unit && <span className="sport-unit"> {sport.unit}</span>}
            </p>
            {sport.detail && <p className="sport-detail">{sport.detail}</p>}
            {sport.year && (
              <p className="sport-year">
                <span className="sport-year-label">{year}</span> {sport.year}
              </p>
            )}
            {sport.note && <p className="sport-year">{sport.note}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}

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

// Batched deliberately (one request, not thirty per row nobody may open); reruns
// only for activities not already covered. Failure is silent — the map stays
// empty, every row reports "unknown", degrading gracefully rather than breaking.
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
