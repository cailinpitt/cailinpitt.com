// The film card for /watching. Kept out of the page file so the card and the
// pagination around it stay readable side by side, matching ReadingBits.

import { Art } from './ListeningBits'
import {
  formatWatchedDate,
  letterboxdUrl,
  stars,
  watchingImage,
  type Film,
} from '../lib/watching'

export function FilmCard({ film }: { film: Film }) {
  const href = letterboxdUrl(film)
  const rating = stars(film.rating)
  const date = formatWatchedDate(film.watchedDate)

  const inner = (
    <>
      {/* alt="" because the title sits right beside it — announcing the poster
          too would just make a screen reader say the film twice. */}
      <Art src={watchingImage(film.poster)} alt="" className="film-poster" />
      <span className="film-meta">
        <span className="film-title">
          {film.title}
          {film.year && <span className="film-year">{film.year}</span>}
        </span>
        <span className="film-marks">
          {rating && (
            <span className="film-rating" aria-label={`Rated ${film.rating} out of 5`}>
              {rating}
            </span>
          )}
          {film.liked && (
            <span className="film-like">
              <span aria-hidden="true">♥</span>
              <span className="visually-hidden">Liked</span>
            </span>
          )}
          {film.rewatch && <span className="film-rewatch">rewatch</span>}
        </span>
        {date && <span className="film-date">{date}</span>}
      </span>
    </>
  )

  return (
    <li className="film-card">
      {href ? (
        <a className="film-link" href={href} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      ) : (
        <span className="film-link">{inner}</span>
      )}
    </li>
  )
}
