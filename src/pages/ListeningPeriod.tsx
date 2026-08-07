// One period of listening — a week, a month, a year, or all of it.
//
// All four granularities are this one component: the Worker ships the same blob
// shape for each, so the only thing that changes is the navigator and which
// sections have data to show.

import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Seo } from '../components/Seo'
import {
  BookendsSection,
  DiscoverySection,
  GenreSection,
  HabitsSection,
  Headline,
  Leaderboards,
  MilestonesSection,
  TimeSection,
  TrendSection,
  WhenSection,
  ZoomOut,
} from '../components/PeriodStats'
import {
  convertKey,
  labelFor,
  parseRoute,
  shortLabelFor,
  step,
  urlFor,
  type PeriodKind,
} from '../lib/periodKeys'
import { fetchPeriod, PeriodNotReady, type PeriodStats } from '../lib/listening'

const GRANULARITIES: { kind: PeriodKind; label: string }[] = [
  { kind: 'w', label: 'Week' },
  { kind: 'm', label: 'Month' },
  { kind: 'y', label: 'Year' },
  { kind: 'all', label: 'All time' },
]

type State =
  | { status: 'loading' }
  | { status: 'ready'; stats: PeriodStats }
  | { status: 'pending' }
  | { status: 'error' }

export function Component() {
  const params = useParams<{ a?: string; b?: string }>()
  const period = parseRoute(params.a, params.b)
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    if (!period) return
    let active = true
    const controller = new AbortController()
    setState({ status: 'loading' })

    fetchPeriod(period.kind, period.key, controller.signal)
      .then((stats) => {
        if (active) setState({ status: 'ready', stats })
      })
      .catch((err: Error) => {
        if (!active || err.name === 'AbortError') return
        // A valid period the cron hasn't reached yet is a different thing from a
        // broken API, and says so — it resolves on its own within minutes.
        setState({ status: err instanceof PeriodNotReady ? 'pending' : 'error' })
      })

    return () => {
      active = false
      controller.abort()
    }
    // Re-fetch on the period itself, not the object identity parseRoute returns.
  }, [period?.kind, period?.key])

  if (!period) {
    return (
      <section className="listening period-page">
        <h1>Not a period</h1>
        <p className="lead">
          Try <Link to="/listening">the listening page</Link>.
        </p>
      </section>
    )
  }

  const label = labelFor(period.kind, period.key)

  return (
    <>
      <Seo
        title={`Listening · ${label}`}
        description={`What Cailin Pitt listened to in ${label} — top artists, albums and tracks, listening patterns and discoveries.`}
        path={urlFor(period.kind, period.key)}
      />
      <section className="listening period-page">
        <header className="listening-header">
          <p className="eyebrow">
            <Link to="/listening">Listening</Link>
          </p>
          <h1>{label}</h1>
        </header>

        <PeriodNav kind={period.kind} periodKey={period.key} />

        {state.status === 'loading' && <PeriodSkeleton />}

        {state.status === 'pending' && (
          <p className="listening-error">
            This period hasn't been built yet. The archive fills in a few periods at a time — check
            back shortly.
          </p>
        )}

        {state.status === 'error' && (
          <p className="listening-error">Could not load this period right now. Try again later.</p>
        )}

        {state.status === 'ready' && state.stats.scrobbles === 0 && (
          <p className="listening-error">Nothing played in {label}.</p>
        )}

        {state.status === 'ready' && state.stats.scrobbles > 0 && (
          <>
            <Headline stats={state.stats} />
            <TrendSection series={state.stats.series} label={trendLabel(period.kind)} />
            <Leaderboards stats={state.stats} />
            <GenreSection stats={state.stats} />
            <TimeSection stats={state.stats} />
            <WhenSection stats={state.stats} />
            <DiscoverySection stats={state.stats} />
            <HabitsSection stats={state.stats} />
            <BookendsSection stats={state.stats} />
            <MilestonesSection stats={state.stats} />
            <ZoomOut kind={period.kind} keyName={period.key} />
          </>
        )}
      </section>
    </>
  )
}

const trendLabel = (kind: PeriodKind) =>
  kind === 'y' ? 'By month' : kind === 'all' ? 'By year' : 'By day'

/**
 * Granularity switch plus prev/next.
 *
 * Switching granularity keeps your place rather than jumping to today — going
 * from a week in March 2023 to "month" lands on March 2023, which is almost
 * always what you meant.
 */
function PeriodNav({ kind, periodKey }: { kind: PeriodKind; periodKey: string }) {
  const navigate = useNavigate()
  const prev = step(kind, periodKey, -1)
  const next = step(kind, periodKey, 1)

  return (
    <nav className="period-nav" aria-label="Period">
      <div className="segmented" role="tablist" aria-label="Granularity">
        {GRANULARITIES.map((g) => (
          <button
            key={g.kind}
            role="tab"
            aria-selected={kind === g.kind}
            className={kind === g.kind ? 'active' : undefined}
            onClick={() => {
              const target = convertKey(kind, periodKey, g.kind)
              navigate(urlFor(g.kind, target))
            }}
          >
            {g.label}
          </button>
        ))}
      </div>

      {kind !== 'all' && (
        <div className="period-steps">
          {prev ? (
            <Link className="period-step" to={urlFor(kind, prev)} rel="prev">
              ← {shortLabelFor(kind, prev)}
            </Link>
          ) : (
            <span className="period-step disabled">←</span>
          )}
          {next ? (
            <Link className="period-step" to={urlFor(kind, next)} rel="next">
              {shortLabelFor(kind, next)} →
            </Link>
          ) : (
            <span className="period-step disabled">→</span>
          )}
        </div>
      )}
    </nav>
  )
}

function PeriodSkeleton() {
  return (
    <div className="listening-skeleton" aria-hidden="true">
      <div className="sk-tiles">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="sk-tile" key={i} />
        ))}
      </div>
      <div className="sk-block" />
      <div className="sk-block" />
    </div>
  )
}
