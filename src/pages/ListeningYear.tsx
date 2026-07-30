import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { Art, StatTile, TopAlbums, TopArtists, TopTracks } from '../components/ListeningBits'
import { listeningYears } from '../lib/listeningYears'
import { fetchYear, formatNumber, type YearReview } from '../lib/listening'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Twelve bars — the shape of the year. Direct-labelled, so no axis is needed. */
function MonthChart({ months }: { months: number[] }) {
  const max = months.reduce((m, v) => (v > m ? v : m), 0) || 1
  return (
    <div className="month-chart">
      {months.map((count, i) => (
        <div className="month-col" key={i}>
          <span className="month-count">{count ? formatNumber(count) : ''}</span>
          <span className="month-bar-track" aria-hidden="true">
            <span className="month-bar-fill" style={{ height: `${(count / max) * 100}%` }} />
          </span>
          <span className="month-label">{MONTHS[i]}</span>
        </div>
      ))}
    </div>
  )
}

function YearNav({ current }: { current: number }) {
  return (
    <nav className="year-nav" aria-label="Other years">
      {listeningYears().map((y) => (
        <Link key={y} to={`/listening/${y}`} aria-current={y === current ? 'page' : undefined}>
          {y}
        </Link>
      ))}
      <Link to="/listening">Recent</Link>
    </nav>
  )
}

export function Component() {
  const { year: yearParam } = useParams()
  const year = Number(yearParam)
  const [review, setReview] = useState<YearReview | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!Number.isFinite(year)) return
    let active = true
    const controller = new AbortController()
    setReview(null)
    setError(false)
    fetchYear(year, controller.signal)
      .then((data) => {
        if (active) setReview(data)
      })
      .catch((err) => {
        if (active && (err as Error).name !== 'AbortError') setError(true)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [year])

  const summary = review
    ? `${formatNumber(review.scrobbles)} scrobbles across ${formatNumber(review.activeDays)} days${
        review.complete ? '' : ' so far'
      }.`
    : `A year of listening, tracked via Last.fm.`

  return (
    <>
      <Seo
        title={`Listening · ${year}`}
        description={`What Cailin Pitt listened to in ${year} — top artists, albums, and tracks from the Last.fm archive.`}
        path={`/listening/${year}`}
      />
      <section className="listening">
        <header className="listening-header">
          <h1>{year}</h1>
          <p className="lead">{summary}</p>
          <YearNav current={year} />
        </header>

        {error ? (
          <p className="listening-error">
            Could not load {year}. <Link to="/listening">Back to the listening log →</Link>
          </p>
        ) : !review ? (
          <div className="listening-skeleton" aria-hidden="true">
            <div className="sk-tiles">
              {Array.from({ length: 5 }).map((_, i) => (
                <div className="sk-tile" key={i} />
              ))}
            </div>
            <div className="sk-block" />
          </div>
        ) : (
          <>
            <section aria-labelledby="year-stats-heading">
              <h2 id="year-stats-heading" className="eyebrow">
                {review.complete ? 'The year' : 'So far'}
              </h2>
              <dl className="stat-tiles">
                <StatTile label="Scrobbles" value={review.scrobbles} />
                <StatTile label="Artists" value={review.artists} />
                <StatTile label="Albums" value={review.albums} />
                <StatTile label="Tracks" value={review.tracks} />
                <StatTile label="Per day" value={review.perDay} />
              </dl>
              <p className="year-notes">
                {formatNumber(review.newArtists)} artists heard for the first time
                {review.busiestDay && (
                  <>
                    {' · '}busiest day {review.busiestDay.date} with{' '}
                    {formatNumber(review.busiestDay.count)} scrobbles
                  </>
                )}
              </p>
            </section>

            <section aria-labelledby="year-months-heading">
              <h2 id="year-months-heading" className="eyebrow">
                By month
              </h2>
              <MonthChart months={review.months} />
            </section>

            {review.firstScrobble && (
              <section aria-labelledby="year-first-heading">
                <h2 id="year-first-heading" className="eyebrow">
                  First play of the year
                </h2>
                <div className="now-card">
                  <Art src={review.firstScrobble.image} alt="" className="now-art" />
                  <div className="now-meta">
                    <p className="now-track">{review.firstScrobble.track}</p>
                    <p className="now-artist">{review.firstScrobble.artist}</p>
                    {review.firstScrobble.album && (
                      <p className="now-album">{review.firstScrobble.album}</p>
                    )}
                  </div>
                </div>
              </section>
            )}

            <section aria-labelledby="year-top-heading">
              <h2 id="year-top-heading" className="eyebrow">
                Most played
              </h2>
              <div className="top-grid">
                <TopArtists artists={review.topArtists} />
                <TopAlbums albums={review.topAlbums} />
                <TopTracks tracks={review.topTracks} />
              </div>
            </section>
          </>
        )}
      </section>
    </>
  )
}
