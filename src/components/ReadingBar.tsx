import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatTime } from '../lib/datetime'
import { fetchReadingNow, formatBookDate, readingImage, type ReadingNow } from '../lib/reading'

// Currently-reading strip, counterpart to NowPlayingBar. No polling, unlike
// that bar: books sync once a day, so there's nothing to refresh mid-visit.
export function ReadingBar({ showLogLinks = true }: { showLogLinks?: boolean } = {}) {
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
  const article = now?.todaysArticle
  if (!book && !article) return null

  const finishedOn = book ? formatBookDate(book.finishedAt) : null
  const others = (now?.currentlyReading?.length ?? 0) - 1

  return (
    <>
      {book && (
        <>
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
                <span className="now-bar-art is-cover book-emoji-placeholder" aria-hidden="true">
                  📖
                </span>
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
          {showLogLinks && (
            <p className="more">
              <Link to="/reading">Book log →</Link>
            </p>
          )}
        </>
      )}

      {/* Endpoint returns null when nothing was saved today, rather than a stale link. */}
      {article && (
        <>
          <div className="now-bar">
            <a
              className="now-bar-main"
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {article.image ? (
                <img
                  className="now-bar-art is-card"
                  src={readingImage(article.image) ?? undefined}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span className="now-bar-art is-card art-placeholder" aria-hidden="true" />
              )}
              <span className="now-bar-text">
                <span className="now-bar-label">Read today · {formatTime(article.readAt)}</span>
                <span className="now-bar-track">
                  <span className="now-bar-title">{article.title ?? article.url}</span>
                  {article.site && <span className="now-bar-artist">{article.site}</span>}
                </span>
              </span>
            </a>
          </div>
          {showLogLinks && (
            <p className="more">
              <Link to="/reading/articles">Article log →</Link>
            </p>
          )}
        </>
      )}
    </>
  )
}
