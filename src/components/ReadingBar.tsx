import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchReadingNow, formatBookDate, readingImage, type ReadingNow } from '../lib/reading'

/**
 * Compact currently-reading strip for the homepage, the counterpart to
 * NowPlayingBar. Client-fetched from the lightweight /now.json endpoint; renders
 * nothing until it has data, so the prerendered shell and any API hiccup just
 * leave the homepage clean.
 *
 * No polling, unlike the listening bar: books sync once a day, so there is
 * nothing to refresh while someone sits on the page.
 */
export function ReadingBar() {
  const [now, setNow] = useState<ReadingNow | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchReadingNow(controller.signal).catch(() => null).then((data) => {
      if (data) setNow(data)
    })
    return () => controller.abort()
  }, [])

  // Fall back to the last finished book so the strip isn't empty between books.
  const reading = now?.currentlyReading?.[0]
  const book = reading ?? now?.lastFinished
  if (!book) return null

  const finishedOn = formatBookDate(book.finishedAt)
  const others = (now?.currentlyReading?.length ?? 0) - 1

  return (
    <div className="now-bar">
      <Link className="now-bar-main" to="/reading" aria-label="Reading">
        {book.cover ? (
          <img
            className="now-bar-art is-cover"
            src={readingImage(book.cover) ?? undefined}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="now-bar-art is-cover art-placeholder" aria-hidden="true" />
        )}
        <span className="now-bar-text">
          <span className="now-bar-label">
            {reading
              ? `Currently reading${others > 0 ? ` · +${others} more` : ''}`
              : finishedOn
                ? `Last finished · ${finishedOn}`
                : 'Last finished'}
          </span>
          <span className="now-bar-track">
            <span className="now-bar-title">{book.title}</span>
            {book.authors && <span className="now-bar-artist">{book.authors}</span>}
          </span>
        </span>
      </Link>
    </div>
  )
}
