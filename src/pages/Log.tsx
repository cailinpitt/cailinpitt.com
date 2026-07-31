import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { dayKey, formatDayLabel, formatNumber, formatTime } from '../lib/datetime'
import { imageUrl } from '../lib/images'
import { fetchBundle, fetchOlderDays, type DayLog } from '../lib/listening'
import {
  fetchOlderArticles,
  fetchOlderBooks,
  fetchReading,
  hardcoverUrl,
  type Article,
  type Book,
} from '../lib/reading'
import type { PostSummary } from '../lib/posts'
import { buildTimeline, type DatedPhoto, type TimelineDay } from '../lib/timeline'
import { pageSchema } from '../lib/structuredData'

interface LogData {
  posts: PostSummary[]
  photos: DatedPhoto[]
}

/** Listening days pulled per page. The Worker caps /days at 14. */
const DAY_PAGE = 14
/** Stops a runaway top-up if a cursor never drains. 10 pages is ~200 items. */
const TOP_UP_LIMIT = 10

export async function loader(): Promise<LogData | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    const { loadDatedPhotos, loadPostSummaries } = await import('../lib/content.client')
    return { posts: loadPostSummaries(), photos: loadDatedPhotos() }
  }
  const { loadDatedPhotos, loadPostSummaries } = await import('../lib/content.server')
  const [posts, photos] = await Promise.all([loadPostSummaries(), loadDatedPhotos()])
  return { posts, photos }
}

/**
 * Pull more of a cursor-paged stream until it reaches back past `floor` — the
 * other streams have to cover the whole window the listening days opened up, or
 * the older rows would understate what happened on them.
 */
async function topUp<T>(
  items: T[],
  cursor: string | null,
  floor: string | null,
  dateOf: (item: T) => string | null,
  load: (cursor: string, signal: AbortSignal) => Promise<{ items: T[]; nextCursor: string | null }>,
  signal: AbortSignal,
): Promise<{ items: T[]; cursor: string | null }> {
  let all = items
  let next = cursor
  for (let page = 0; next && page < TOP_UP_LIMIT; page++) {
    const oldest = all.length ? dateOf(all[all.length - 1]) : null
    // Once the tail is older than the floor, the window is covered. A null floor
    // means listening is exhausted and everything left should be shown.
    if (floor && oldest && oldest < floor) break
    const result = await load(next, signal)
    all = [...all, ...result.items]
    next = result.nextCursor
  }
  return { items: all, cursor: next }
}

const bookDate = (book: Book) => book.finishedAt?.slice(0, 10) ?? book.startedAt?.slice(0, 10) ?? null

function useTimeline(posts: PostSummary[], photos: DatedPhoto[]) {
  const [days, setDays] = useState<DayLog[]>([])
  const [articles, setArticles] = useState<Article[]>([])
  const [books, setBooks] = useState<Book[]>([])
  const [before, setBefore] = useState<number | null>(null)
  const [articleCursor, setArticleCursor] = useState<string | null>(null)
  const [bookCursor, setBookCursor] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    Promise.all([fetchBundle(controller.signal), fetchReading(controller.signal)])
      .then(([listening, reading]) => {
        setDays(listening.recentDays)
        setBefore(listening.nextBefore)
        setArticles(reading.articles)
        setArticleCursor(reading.nextCursor)
        setBooks([...reading.currentlyReading, ...reading.finishedBooks])
        setBookCursor(reading.nextBookCursor)
        setReady(true)
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(true)
      })
    return () => controller.abort()
  }, [])

  // Scrobbles are the densest stream and the only one worth a real cursor, so the
  // oldest loaded listening day is how far back the page can honestly go.
  const floor = before != null && days.length ? days[days.length - 1].date : null

  const loadMore = useCallback(async () => {
    if (before == null || loading) return
    setLoading(true)
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const older = await fetchOlderDays(before, DAY_PAGE, controller.signal)
      const nextDays = [...days, ...older.days]
      const nextFloor =
        older.nextBefore != null && nextDays.length ? nextDays[nextDays.length - 1].date : null

      const [nextArticles, nextBooks] = await Promise.all([
        topUp(
          articles,
          articleCursor,
          nextFloor,
          // Same local bucketing buildTimeline uses, so "reached the floor" here
          // means the same thing it will mean when the rows are assembled.
          (article) => dayKey(article.readAt),
          async (cursor, signal) => {
            const page = await fetchOlderArticles(cursor, 20, signal)
            return { items: page.articles, nextCursor: page.nextCursor }
          },
          controller.signal,
        ),
        topUp(
          books,
          bookCursor,
          nextFloor,
          bookDate,
          async (cursor, signal) => {
            const page = await fetchOlderBooks(cursor, 24, signal)
            return { items: page.books, nextCursor: page.nextCursor }
          },
          controller.signal,
        ),
      ])

      setDays(nextDays)
      setBefore(older.nextBefore)
      setArticles(nextArticles.items)
      setArticleCursor(nextArticles.cursor)
      setBooks(nextBooks.items)
      setBookCursor(nextBooks.cursor)
    } catch (err) {
      // Stop offering the button rather than looping on a broken endpoint.
      if ((err as Error)?.name !== 'AbortError') setBefore(null)
    } finally {
      setLoading(false)
    }
  }, [articleCursor, articles, before, bookCursor, books, days, loading])

  const timeline = useMemo(
    () => buildTimeline({ days, articles, books, posts, photos, floor }),
    [articles, books, days, floor, photos, posts],
  )

  return { timeline, ready, error, loading, hasMore: before != null, loadMore }
}

export function Component() {
  const { posts, photos } = useLoaderData() as LogData
  const { timeline, ready, error, loading, hasMore, loadMore } = useTimeline(posts, photos)

  return (
    <div className="log">
      <Seo
        title="Log"
        description="Everything Cailin Pitt listened to, read, wrote, and photographed, day by day."
        path="/log"
        jsonLd={pageSchema({
          path: '/log',
          title: 'Log',
          description:
            'Everything Cailin Pitt listened to, read, wrote, and photographed, day by day.',
          type: 'CollectionPage',
        })}
      />
      <h1>Log</h1>
      <p className="lead">
        One row per day, pulling together <Link to="/listening">listening</Link>,{' '}
        <Link to="/reading">reading</Link>, <Link to="/blog">writing</Link>, and{' '}
        <Link to="/photos">photos</Link>.
      </p>

      {error && !ready ? (
        <p className="log-error">Could not load the log right now. Try again later.</p>
      ) : !ready ? (
        <div className="log-skeleton" aria-hidden="true">
          <div className="sk-block" />
          <div className="sk-block" />
          <div className="sk-block" />
        </div>
      ) : (
        <>
          <ol className="log-days">
            {timeline.map((day) => (
              <LogDay key={day.date} day={day} />
            ))}
          </ol>
          {hasMore && (
            <button className="load-more" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load older days'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function LogDay({ day }: { day: TimelineDay }) {
  return (
    <li className="log-day">
      <h2 className="log-date">
        {formatDayLabel(day.date)}
        <span className="log-year">{day.date.slice(0, 4)}</span>
      </h2>
      <ul className="log-events">
        {day.scrobbles > 0 && (
          <li className="log-event">
            <span className="log-icon" aria-hidden="true">
              🎧
            </span>
            <span>
              <Link to="/listening">{formatNumber(day.scrobbles)} scrobbles</Link>
              {day.topArtist && <span className="log-detail"> · top: {day.topArtist}</span>}
            </span>
          </li>
        )}

        {day.articles.length > 0 && (
          <li className="log-event">
            <span className="log-icon" aria-hidden="true">
              🔗
            </span>
            <span>
              <span className="log-label">
                {day.articles.length} {day.articles.length === 1 ? 'article' : 'articles'} saved
              </span>
              <ul className="log-sublist">
                {day.articles.map((article) => (
                  <li key={article.id}>
                    <a href={article.url} target="_blank" rel="noopener noreferrer">
                      {article.title ?? article.url}
                    </a>
                    <span className="log-detail">
                      {article.site && ` — ${article.site}`} · {formatTime(article.readAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </span>
          </li>
        )}

        {day.booksFinished.map((book) => (
          <BookEvent key={`fin-${book.userBookId}-${book.readId}`} book={book} verb="Finished" />
        ))}
        {day.booksStarted.map((book) => (
          <BookEvent key={`start-${book.userBookId}-${book.readId}`} book={book} verb="Started" />
        ))}

        {day.posts.map((post) => (
          <li className="log-event" key={post.path}>
            <span className="log-icon" aria-hidden="true">
              ✍️
            </span>
            <span>
              <span className="log-label">Published</span> <Link to={post.path}>{post.title}</Link>
            </span>
          </li>
        ))}

        {day.photos.length > 0 && (
          <li className="log-event">
            <span className="log-icon" aria-hidden="true">
              📸
            </span>
            <span>
              <span className="log-label">
                {day.photos.length} {day.photos.length === 1 ? 'photo' : 'photos'}
              </span>{' '}
              <Link to={day.photos[0].galleryPath}>{day.photos[0].galleryTitle}</Link>
              <ul className="log-thumbs">
                {day.photos.map((photo) => (
                  <li key={photo.src}>
                    {/* Straight into the lightbox at that frame. */}
                    <Link to={`${photo.galleryPath}?photo=${photo.index}`}>
                      <img
                        src={imageUrl(photo.thumb ?? photo.src)}
                        alt={photo.alt}
                        loading="lazy"
                        decoding="async"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </span>
          </li>
        )}
      </ul>
    </li>
  )
}

function BookEvent({ book, verb }: { book: Book; verb: 'Finished' | 'Started' }) {
  const href = hardcoverUrl(book)
  return (
    <li className="log-event">
      <span className="log-icon" aria-hidden="true">
        📚
      </span>
      <span>
        <span className="log-label">{verb}</span>{' '}
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {book.title}
          </a>
        ) : (
          book.title
        )}
        {book.authors && <span className="log-detail"> — {book.authors}</span>}
      </span>
    </li>
  )
}
