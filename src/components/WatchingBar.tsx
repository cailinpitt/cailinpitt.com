import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchWatchingNow,
  formatWatchedLabel,
  stars,
  watchingImage,
  type WatchingNow,
} from '../lib/watching'

/**
 * Compact last-watched strip, counterpart to ReadingBar. Client-fetched from
 * /now.json; renders nothing until it has data, so a hiccup leaves the page
 * clean. No polling — films sync once a day. Links to /watching, not
 * Letterboxd; the film's Letterboxd page is one click further, from the card.
 */
export function WatchingBar() {
  const [now, setNow] = useState<WatchingNow | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchWatchingNow(controller.signal)
      .catch(() => null)
      .then((data) => {
        if (data) setNow(data)
      })
    return () => controller.abort()
  }, [])

  const film = now?.lastFilm
  if (!film) return null

  const watched = formatWatchedLabel(film.watchedDate)
  const rating = stars(film.rating)
  // Year and rating share the secondary line; both optional (an unrated film still belongs here).
  const secondary = [film.year, rating].filter(Boolean).join(' · ')

  return (
    <div className="now-bar">
      <Link className="now-bar-main" to="/watching" aria-label="Watching">
        {film.poster ? (
          <img
            className="now-bar-art is-cover"
            src={watchingImage(film.poster) ?? undefined}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="now-bar-art is-cover art-placeholder" aria-hidden="true" />
        )}
        <span className="now-bar-text">
          <span className="now-bar-label">
            {film.rewatch ? 'Last watched · rewatch' : 'Last watched'}
            {watched ? ` · ${watched}` : ''}
          </span>
          <span className="now-bar-track">
            <span className="now-bar-title">{film.title}</span>
            {secondary && <span className="now-bar-artist">{secondary}</span>}
          </span>
        </span>
      </Link>
    </div>
  )
}
