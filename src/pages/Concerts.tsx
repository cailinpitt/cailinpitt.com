import { useMemo } from 'react'
import { useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { StatTile } from '../components/ListeningBits'
import { pageSchema } from '../lib/structuredData'
import {
  concertCounts,
  concertLineup,
  concertPlace,
  concertTitle,
  concertsByYear,
  formatConcertDate,
  type Concert,
} from '../lib/concerts'

const DESCRIPTION = 'Concerts Cailin Pitt has been to, logged on Concert Archives.'

export async function loader(): Promise<Concert[] | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    return (await import('../lib/content.client')).loadConcerts()
  }
  const { loadConcerts } = await import('../lib/content.server')
  return await loadConcerts()
}

export function Component() {
  const concerts = useLoaderData() as Concert[]
  const years = useMemo(() => concertsByYear(concerts), [concerts])
  const counts = useMemo(
    () => concertCounts(concerts, new Date().getFullYear()),
    [concerts],
  )

  return (
    <div className="concerts">
      <Seo
        title="Concerts"
        description={DESCRIPTION}
        path="/concerts"
        jsonLd={pageSchema({
          path: '/concerts',
          title: 'Concerts',
          description: DESCRIPTION,
          type: 'CollectionPage',
        })}
      />

      <h1>Concerts</h1>
      <p>Shows I've been to, logged on Concert Archives.</p>

      {concerts.length === 0 ? (
        <p className="concerts-empty">Nothing logged yet.</p>
      ) : (
        <>
          <section className="concerts-stats" aria-labelledby="concerts-stats-heading">
            <h2 id="concerts-stats-heading" className="visually-hidden">
              Totals
            </h2>
            <dl className="stat-tiles">
              <StatTile label="Concerts" value={counts.concerts} />
              <StatTile label="This year" value={counts.concertsThisYear} />
              <StatTile label="Venues" value={counts.venues} />
              <StatTile label="Artists" value={counts.artists} />
            </dl>
          </section>

          <section className="concerts-log" aria-labelledby="concerts-log-heading">
            <h2 id="concerts-log-heading" className="eyebrow">
              🎤 Shows
            </h2>
            {years.map(({ year, concerts }) => (
              <div className="concert-year" key={year}>
                <h3 className="concert-year-label">
                  {year}
                  <span className="concert-year-count">
                    {concerts.length} {concerts.length === 1 ? 'show' : 'shows'}
                  </span>
                </h3>
                <ul className="concert-list">
                  {concerts.map((concert) => (
                    <ConcertCard key={concert.id} concert={concert} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  )
}

function ConcertCard({ concert }: { concert: Concert }) {
  const title = concertTitle(concert)
  const lineup = concertLineup(concert)
  const place = concertPlace(concert)
  const date = formatConcertDate(concert.date)

  const inner = (
    <>
      <span className="concert-title">{title}</span>
      {lineup && <span className="concert-lineup">{lineup}</span>}
      {place && <span className="concert-venue">{place}</span>}
      {date && <span className="concert-date">{date}</span>}
    </>
  )

  return (
    <li className="concert-card">
      {concert.url ? (
        <a className="concert-link" href={concert.url} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      ) : (
        <span className="concert-link">{inner}</span>
      )}
    </li>
  )
}
