import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Seo } from '../components/Seo'
import { CurlHint } from '../components/CurlHint'
import { StatTile } from '../components/ListeningBits'
import { FilmCard } from '../components/WatchingBits'
import { pageSchema } from '../lib/structuredData'
import {
  fetchOlderFilms,
  fetchWatching,
  filmsByYear,
  type Film,
  type WatchingBundle,
} from '../lib/watching'

export function Component() {
  const [bundle, setBundle] = useState<WatchingBundle | null>(null)
  const [error, setError] = useState(false)

  // No polling, unlike /listening: this syncs once a day, so nothing here
  // changes while the page is open.
  useEffect(() => {
    const controller = new AbortController()
    fetchWatching(controller.signal)
      .then(setBundle)
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(true)
      })
    return () => controller.abort()
  }, [])

  return (
    <div className="watching">
      <Seo
        title="Watching"
        description="Films Cailin Pitt has been watching, and what he made of them."
        path="/watching"
        jsonLd={pageSchema({
          path: '/watching',
          title: 'Watching',
          description: 'Films Cailin Pitt has been watching, and what he made of them.',
          type: 'CollectionPage',
        })}
      />

      <h1>Watching</h1>
      <p className="lead">
        Films I have watched, logged on Letterboxd. Ratings are out of five, halves
        included.
      </p>
      <CurlHint command="curl watching.cailinpitt.com" />

      {error && !bundle ? (
        <p className="watching-error">Could not load watching data right now. Try again later.</p>
      ) : !bundle ? (
        <WatchingSkeleton />
      ) : (
        <>
          <section className="watching-stats" aria-labelledby="watching-stats-heading">
            <h2 id="watching-stats-heading" className="visually-hidden">
              Totals
            </h2>
            <dl className="stat-tiles">
              <StatTile label="Films" value={bundle.counts.films} />
              <StatTile label="This year" value={bundle.counts.filmsThisYear} />
              <StatTile
                label="Average rating"
                value={bundle.counts.meanRating != null ? bundle.counts.meanRating.toFixed(2) : '—'}
              />
              <StatTile label="Rewatches" value={bundle.counts.rewatches} />
            </dl>
          </section>

          <FilmLog
            initial={bundle.films}
            initialCursor={bundle.nextCursor}
            total={bundle.counts.films}
          />
        </>
      )}
    </div>
  )
}

// ---- the log -------------------------------------------------------------

function FilmLog({
  initial,
  initialCursor,
  total,
}: {
  initial: Film[]
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
      const page = await fetchOlderFilms(cursor, 24, controller.signal)
      setItems((prev) => {
        // The cursor is exclusive, but dedupe anyway — something logged between
        // two requests could otherwise land on both pages.
        const seen = new Set(prev.map((film) => film.id))
        return [...prev, ...page.films.filter((film) => !seen.has(film.id))]
      })
      setCursor(page.nextCursor)
    } catch (err) {
      // Stop offering the button rather than looping on a broken endpoint.
      if ((err as Error)?.name !== 'AbortError') setCursor(null)
    } finally {
      setLoading(false)
    }
  }, [cursor, loading])

  const years = useMemo(() => filmsByYear(items), [items])

  if (!items.length) {
    return <p className="watching-empty">Nothing logged yet.</p>
  }

  return (
    <section className="watching-films" aria-labelledby="watching-films-heading">
      <h2 id="watching-films-heading" className="eyebrow">
        🎬 Films
      </h2>
      {years.map(({ year, films }) => (
        <div className="film-year" key={year}>
          <h3 className="film-year-label">
            {year}
            <span className="film-year-count">
              {films.length} {films.length === 1 ? 'film' : 'films'}
            </span>
          </h3>
          <ul className="film-grid">
            {films.map((film) => (
              <FilmCard key={film.id} film={film} />
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
            {loading ? 'Loading…' : 'Load older films'}
          </button>
        </>
      )}
    </section>
  )
}

// ---- loading state -------------------------------------------------------

function WatchingSkeleton() {
  return (
    <div className="watching-skeleton" aria-hidden="true">
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
