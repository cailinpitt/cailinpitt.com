// A year, told as a story rather than a table.
//
// Reads the same year blob the period view does — no new endpoint, no new data.
// Everything on this page is derived in src/lib/wrapped.ts, so the page itself
// is only layout.

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { buildCards, deriveTraits, MIN_SCROBBLES, type Card, type Trait } from '../lib/wrapped'
import { currentKey, withinArchive } from '../lib/periodKeys'
import { fetchPeriod, PeriodNotReady, type PeriodStats } from '../lib/listening'

type State =
  | { status: 'loading' }
  | { status: 'ready'; stats: PeriodStats }
  | { status: 'pending' }
  | { status: 'error' }

export function Component() {
  const params = useParams<{ year?: string }>()
  // No year in the URL means this year. An out-of-range one falls back rather
  // than 404ing, since /listening/wrapped is the shareable address.
  const year =
    params.year && withinArchive('y', params.year) ? params.year : currentKey('y')

  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setState({ status: 'loading' })

    fetchPeriod('y', year, controller.signal)
      .then((stats) => {
        if (active) setState({ status: 'ready', stats })
      })
      .catch((err: Error) => {
        if (!active || err.name === 'AbortError') return
        setState({ status: err instanceof PeriodNotReady ? 'pending' : 'error' })
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [year])

  return (
    <>
      <Seo
        title={`Listening · ${year} wrapped`}
        description={`Cailin Pitt's ${year} in music — top artists, tracks and genres, listening time, and the patterns behind them.`}
        path={`/listening/wrapped/${year}`}
      />
      <section className="listening wrapped">
        <header className="wrapped-header">
          <p className="eyebrow">
            <Link to="/listening">Listening</Link>
          </p>
          <h1>
            <span className="wrapped-year">{year}</span>
            <span className="wrapped-sub">in music</span>
          </h1>
        </header>

        {state.status === 'loading' && <p className="muted-note">Putting it together…</p>}

        {state.status === 'pending' && (
          <p className="listening-error">
            {year} hasn't been built yet. Check back shortly.
          </p>
        )}

        {state.status === 'error' && (
          <p className="listening-error">Could not load {year} right now.</p>
        )}

        {state.status === 'ready' && <WrappedBody stats={state.stats} year={year} />}
      </section>
    </>
  )
}

function WrappedBody({ stats, year }: { stats: PeriodStats; year: string }) {
  const cards = buildCards(stats)
  const traits = deriveTraits(stats)

  // Below the floor the numbers are noise, and a Wrapped built on 12 scrobbles
  // would be confidently meaningless.
  if (stats.scrobbles < MIN_SCROBBLES) {
    return (
      <p className="listening-error">
        Not enough listening in {year} to make a story out of — {stats.scrobbles} scrobbles.{' '}
        <Link to={`/listening/${year}`}>See the raw numbers</Link>.
      </p>
    )
  }

  return (
    <>
      <ol className="wrapped-cards">
        {cards.map((card, i) => (
          <WrappedCard key={card.kicker} card={card} index={i} />
        ))}
      </ol>

      {traits.length > 0 && <Traits traits={traits} />}

      <p className="wrapped-more">
        <Link to={`/listening/${year}`}>All the numbers for {year} →</Link>
      </p>
    </>
  )
}

function WrappedCard({ card, index }: { card: Card; index: number }) {
  return (
    <li className="wrapped-card" style={{ '--i': index } as React.CSSProperties}>
      <p className="wrapped-kicker">{card.kicker}</p>
      <p className="wrapped-value">{card.value}</p>
      {card.detail && <p className="wrapped-detail">{card.detail}</p>}
    </li>
  )
}

function Traits({ traits }: { traits: Trait[] }) {
  return (
    <section className="wrapped-traits" aria-labelledby="traits-heading">
      <h2 id="traits-heading" className="eyebrow">
        What that makes you
      </h2>
      <ul className="trait-list">
        {traits.map((t) => (
          <li key={t.label}>
            <span className="trait-label">{t.label}</span>
            <span className="trait-detail">{t.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
