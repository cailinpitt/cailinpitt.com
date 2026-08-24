import { Link } from 'react-router-dom'
import { concertPlace, formatConcertDate, type Concert } from '../lib/concerts'

export function ConcertBar({ concert }: { concert: Concert | null }) {
  if (!concert) return null

  const lineup = concert.artists.join(' / ')
  const place = concertPlace(concert)
  const date = formatConcertDate(concert.date)

  return (
    <div className="now-bar">
      <Link className="now-bar-main" to="/concerts" aria-label="Concerts">
        <span className="now-bar-art moving-bar-mark" aria-hidden="true">
          🎤
        </span>
        <span className="now-bar-text">
          <span className="now-bar-label">Last seen{date ? ` · ${date}` : ''}</span>
          <span className="now-bar-track">
            <span className="now-bar-title">{lineup}</span>
            {place && <span className="now-bar-artist">{place}</span>}
          </span>
        </span>
      </Link>
    </div>
  )
}
