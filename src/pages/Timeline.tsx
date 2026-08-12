import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { dayKey, formatDayLabel, formatNumber, formatTime, keyForOffset } from '../lib/datetime'
import { imageUrl } from '../lib/images'
import { fetchOlderCompactDays, fetchTimelineDays, type CompactDay } from '../lib/listening'
import {
  faviconUrl,
  fetchOlderArticles,
  fetchOlderBooks,
  fetchReading,
  hardcoverUrl,
  type Article,
  type Book,
} from '../lib/reading'
import {
  fetchOlderFilms,
  fetchWatching,
  letterboxdUrl,
  stars,
  type Film,
} from '../lib/watching'
import {
  fetchMoving,
  fetchOlderActivities,
  kindIcon,
  summary as activitySummary,
  type Activity,
} from '../lib/moving'
import { fetchNotes, fetchOlderNotes, notePath, type Note } from '../lib/notes'
import { resolveContext, type ContextSources } from '../lib/notesContext'
import { LinkCard } from '../components/LinkCard'
import { NoteText } from '../components/NoteText'
import type { Photo } from '../lib/photos'
import type { PostSummary } from '../lib/posts'
import { buildTimeline, onThisDay, type TimelineDay } from '../lib/timeline'
import { pageSchema } from '../lib/structuredData'

interface TimelineData {
  posts: PostSummary[]
  photos: Photo[]
}

/** Listening days pulled per page. The Worker caps /days at 14. */
const DAY_PAGE = 14
/** Stops a runaway top-up if a cursor never drains. 10 pages is ~200 items. */
const TOP_UP_LIMIT = 10

export async function loader(): Promise<TimelineData | null> {
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
 *
 * **A stream that fails gives back what it already had**, rather than rejecting.
 * These run as a batch, and one unreachable Worker used to fail the batch and
 * with it the whole "load older" click — five streams' worth of history thrown
 * away because the sixth timed out. Swallowing here keeps the failure the size
 * of the thing that failed, which is the same contract the initial load keeps.
 *
 * The cursor is returned unchanged on failure rather than nulled, so the next
 * click retries that stream instead of writing it off for the session — the
 * common cause is a blip, not a dead endpoint.
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
    try {
      const result = await load(next, signal)
      all = [...all, ...result.items]
      next = result.nextCursor
    } catch {
      return { items: all, cursor: next }
    }
  }
  return { items: all, cursor: next }
}

const bookDate = (book: Book) => book.finishedAt?.slice(0, 10) ?? book.startedAt?.slice(0, 10) ?? null
const filmDate = (film: Film) => film.watchedDate.slice(0, 10)
const activityDate = (activity: Activity) => activity.startDate

function useTimeline(posts: PostSummary[], photos: Photo[]) {
  const [days, setDays] = useState<CompactDay[]>([])
  const [articles, setArticles] = useState<Article[]>([])
  const [books, setBooks] = useState<Book[]>([])
  const [films, setFilms] = useState<Film[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [noteCursor, setNoteCursor] = useState<string | null>(null)
  const [before, setBefore] = useState<number | null>(null)
  const [articleCursor, setArticleCursor] = useState<string | null>(null)
  const [bookCursor, setBookCursor] = useState<string | null>(null)
  const [filmCursor, setFilmCursor] = useState<string | null>(null)
  const [activityCursor, setActivityCursor] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller

    // allSettled, not all.
    //
    // This page is the only one that reads *every* Worker, which makes it the
    // one place where "a Worker is down" is most likely to be true of something.
    // With Promise.all, any single unreachable endpoint rejected the whole batch
    // and the page rendered its error state — five working streams thrown away
    // because the sixth was unavailable. That is the opposite of the contract
    // the rest of the site keeps ("a Worker being down costs that section and
    // nothing else"), and it is a failure mode that grows more likely with every
    // stream added.
    //
    // So each stream is now allowed to fail on its own. A missing stream
    // contributes no rows and the day is assembled from the rest; the page only
    // reports an error when *nothing* answered, which is the one case where
    // there is genuinely nothing to show.
    Promise.allSettled([
      // The compact projection, not the full bundle: this page shows a count and
      // a top artist per day and renders no individual track, which is ~93% of
      // what the bundle carries.
      fetchTimelineDays(controller.signal),
      fetchReading(controller.signal),
      fetchWatching(controller.signal),
      fetchMoving(controller.signal),
      fetchNotes(controller.signal),
    ]).then(async ([listening, reading, watching, moving, notes]) => {
      if (controller.signal.aborted) return

      // Listening sets the window (see the module comment on buildTimeline):
      // its first page is a fixed 14 days, deeper than any other stream's
      // default first page. Without topping the rest up to match, a day near
      // the bottom of that window would show scrobbles but silently drop
      // articles/books/films/activities/notes that exist but hadn't been
      // paged in yet — the same gap "Load older days" closes via topUp(),
      // just not yet visible for a page nobody has paged past.
      let initialFloor: string | null = null
      if (listening.status === 'fulfilled') {
        setDays(listening.value.days)
        setBefore(listening.value.nextBefore)
        initialFloor =
          listening.value.nextBefore != null && listening.value.days.length
            ? listening.value.days[listening.value.days.length - 1].date
            : null
      }

      if (reading.status === 'fulfilled') {
        const [toppedArticles, toppedBooks] = await Promise.all([
          topUp(
            reading.value.articles,
            reading.value.nextCursor,
            initialFloor,
            (article) => dayKey(article.readAt),
            async (cursor, signal) => {
              const page = await fetchOlderArticles(cursor, 20, signal)
              return { items: page.articles, nextCursor: page.nextCursor }
            },
            controller.signal,
          ),
          topUp(
            [...reading.value.currentlyReading, ...reading.value.finishedBooks],
            reading.value.nextBookCursor,
            initialFloor,
            bookDate,
            async (cursor, signal) => {
              const page = await fetchOlderBooks(cursor, 24, signal)
              return { items: page.books, nextCursor: page.nextCursor }
            },
            controller.signal,
          ),
        ])
        setArticles(toppedArticles.items)
        setArticleCursor(toppedArticles.cursor)
        setBooks(toppedBooks.items)
        setBookCursor(toppedBooks.cursor)
      }
      if (watching.status === 'fulfilled') {
        const toppedFilms = await topUp(
          watching.value.films,
          watching.value.nextCursor,
          initialFloor,
          filmDate,
          async (cursor, signal) => {
            const page = await fetchOlderFilms(cursor, 24, signal)
            return { items: page.films, nextCursor: page.nextCursor }
          },
          controller.signal,
        )
        setFilms(toppedFilms.items)
        setFilmCursor(toppedFilms.cursor)
      }
      if (moving.status === 'fulfilled') {
        const toppedActivities = await topUp(
          moving.value.activities,
          moving.value.nextCursor,
          initialFloor,
          activityDate,
          async (cursor, signal) => {
            const page = await fetchOlderActivities(cursor, 30, signal)
            return { items: page.activities, nextCursor: page.nextCursor }
          },
          controller.signal,
        )
        setActivities(toppedActivities.items)
        setActivityCursor(toppedActivities.cursor)
      }
      if (notes.status === 'fulfilled') {
        const toppedNotes = await topUp(
          notes.value.notes,
          notes.value.nextCursor,
          initialFloor,
          (note) => dayKey(note.createdAt),
          async (cursor, signal) => {
            const page = await fetchOlderNotes(cursor, 25, signal)
            return { items: page.notes, nextCursor: page.nextCursor }
          },
          controller.signal,
        )
        setNotes(toppedNotes.items)
        setNoteCursor(toppedNotes.cursor)
      }

      if (controller.signal.aborted) return

      const streams = [listening, reading, watching, moving, notes]
      // Every stream failing means no network, a total outage, or an ad blocker
      // eating the requests — the error state is honest there. Anything less and
      // the page has something to show.
      setError(streams.every((result) => result.status === 'rejected'))
      setReady(true)
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
      const older = await fetchOlderCompactDays(before, DAY_PAGE, controller.signal)
      const nextDays = [...days, ...older.days]
      const nextFloor =
        older.nextBefore != null && nextDays.length ? nextDays[nextDays.length - 1].date : null

      const [nextArticles, nextBooks, nextFilms, nextActivities, nextNotes] = await Promise.all([
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
        topUp(
          films,
          filmCursor,
          nextFloor,
          filmDate,
          async (cursor, signal) => {
            const page = await fetchOlderFilms(cursor, 24, signal)
            return { items: page.films, nextCursor: page.nextCursor }
          },
          controller.signal,
        ),
        topUp(
          activities,
          activityCursor,
          nextFloor,
          activityDate,
          async (cursor, signal) => {
            const page = await fetchOlderActivities(cursor, 30, signal)
            return { items: page.activities, nextCursor: page.nextCursor }
          },
          controller.signal,
        ),
        topUp(
          notes,
          noteCursor,
          nextFloor,
          // Local bucketing, matching what buildTimeline does with them.
          (note) => dayKey(note.createdAt),
          async (cursor, signal) => {
            const page = await fetchOlderNotes(cursor, 25, signal)
            return { items: page.notes, nextCursor: page.nextCursor }
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
      setFilms(nextFilms.items)
      setFilmCursor(nextFilms.cursor)
      setActivities(nextActivities.items)
      setActivityCursor(nextActivities.cursor)
      setNotes(nextNotes.items)
      setNoteCursor(nextNotes.cursor)
    } catch (err) {
      // Stop offering the button rather than looping on a broken endpoint.
      if ((err as Error)?.name !== 'AbortError') setBefore(null)
    } finally {
      setLoading(false)
    }
  }, [
    activities,
    activityCursor,
    articleCursor,
    articles,
    before,
    bookCursor,
    books,
    days,
    filmCursor,
    films,
    loading,
    noteCursor,
    notes,
  ])

  const timeline = useMemo(
    () => buildTimeline({ days, articles, books, films, activities, posts, photos, notes, floor }),
    [activities, articles, books, days, films, floor, notes, photos, posts],
  )

  return { timeline, ready, error, loading, hasMore: before != null, loadMore }
}

export function Component() {
  const { posts, photos } = useLoaderData() as TimelineData
  const { timeline, ready, error, loading, hasMore, loadMore } = useTimeline(posts, photos)

  // Every activity already folded into a loaded day — not a separate fetch,
  // just what's already on the page, for resolveContext() to search when a
  // note references one (see notesContext.ts).
  const activities = useMemo(() => timeline.flatMap((day) => day.activities), [timeline])
  const contextSources: ContextSources = { posts, photos, activities }

  // Same calendar date in years already loaded, minus today itself — today's
  // row is already the top of the list below, not something "on this day"
  // needs to repeat. See onThisDay() in lib/timeline.ts for why this doesn't
  // reach past what's already on the page.
  const monthDay = keyForOffset(0).slice(5)
  const otd = useMemo(
    () => onThisDay(timeline, monthDay).filter((day) => day.date !== keyForOffset(0)),
    [timeline, monthDay],
  )

  return (
    <div className="timeline">
      <Seo
        title="Timeline"
        description="Everything Cailin Pitt listened to, read, watched, rode, lifted, wrote, noted, and photographed, day by day."
        path="/timeline"
        jsonLd={pageSchema({
          path: '/timeline',
          title: 'Timeline',
          description:
            'Everything Cailin Pitt listened to, read, watched, rode, lifted, wrote, noted, and photographed, day by day.',
          type: 'CollectionPage',
        })}
      />
      <h1>Timeline</h1>
      <p>
        One row per day, pulling together <Link to="/listening">listening</Link>,{' '}
        <Link to="/reading">reading</Link>, <Link to="/watching">watching</Link>,{' '}
        <Link to="/moving">moving</Link>, <Link to="/blog">blog</Link>,{' '}
        <Link to="/notes">notes</Link>, and <Link to="/photos">photos</Link>.
      </p>

      {/* `error` now means *every* stream failed, and it is set at the same time
          as `ready` rather than instead of it — so this tests it on its own.
          Previously it could only be true while `!ready`, which is no longer a
          state this component enters. */}
      {error ? (
        <p className="timeline-error">Could not load the timeline right now. Try again later.</p>
      ) : !ready ? (
        <div className="timeline-skeleton" aria-hidden="true">
          <div className="sk-block" />
          <div className="sk-block" />
          <div className="sk-block" />
        </div>
      ) : (
        <>
          {otd.length > 0 && (
            <section className="timeline-otd" aria-labelledby="timeline-otd-heading">
              <h2 id="timeline-otd-heading" className="eyebrow">
                On this day
              </h2>
              <ol className="timeline-days">
                {otd.map((day) => (
                  <TimelineRow key={day.date} day={day} context={contextSources} />
                ))}
              </ol>
            </section>
          )}

          <ol className="timeline-days">
            {timeline.map((day) => (
              <TimelineRow key={day.date} day={day} context={contextSources} />
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

function TimelineRow({ day, context }: { day: TimelineDay; context?: ContextSources }) {
  return (
    <li className="timeline-day">
      <h2 className="timeline-date">
        {formatDayLabel(day.date)}
        <span className="timeline-year">{day.date.slice(0, 4)}</span>
      </h2>
      <ul className="timeline-events">
        {day.scrobbles > 0 && (
          <li className="timeline-event" data-stream="listening">
            <span className="timeline-icon" aria-hidden="true">
              🎧
            </span>
            <span>
              <Link to="/listening">{formatNumber(day.scrobbles)} scrobbles</Link>
              {day.topArtist && <span className="timeline-detail"> · top: {day.topArtist}</span>}
            </span>
          </li>
        )}

        {day.articles.length > 0 && (
          <li className="timeline-event" data-stream="reading">
            <span className="timeline-icon" aria-hidden="true">
              🔗
            </span>
            <span>
              <span className="timeline-label">
                {day.articles.length} {day.articles.length === 1 ? 'article' : 'articles'} saved
              </span>
              <ul className="timeline-sublist">
                {day.articles.map((article) => {
                  const favicon = faviconUrl(article.url)
                  return (
                    <li key={article.id}>
                      {favicon && (
                        <img
                          className="article-favicon"
                          src={favicon}
                          alt=""
                          width={16}
                          height={16}
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                          }}
                        />
                      )}
                      <a href={article.url} target="_blank" rel="noopener noreferrer">
                        {article.title ?? article.url}
                      </a>
                      <span className="timeline-detail">
                        {article.site && ` — ${article.site}`} · {formatTime(article.readAt)}
                      </span>
                    </li>
                  )
                })}
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

        {day.films.map((film) => (
          <FilmEvent key={film.id} film={film} />
        ))}

        {day.activities.map((activity) => (
          <li className="timeline-event" data-stream="moving" key={activity.id}>
            <span className="timeline-icon" aria-hidden="true">
              {kindIcon(activity.kind)}
            </span>
            <span>
              <Link to="/moving">{activitySummary(activity)}</Link>
            </span>
          </li>
        ))}

        {day.posts.map((post) => (
          <li className="timeline-event" data-stream="writing" key={post.path}>
            <span className="timeline-icon" aria-hidden="true">
              ✍️
            </span>
            <span>
              <span className="timeline-label">Published</span> <Link to={post.path}>{post.title}</Link>
            </span>
          </li>
        ))}

        {day.notes.length > 0 && (
          <li className="timeline-event" data-stream="notes">
            <span className="timeline-icon" aria-hidden="true">
              💬
            </span>
            <span>
              <span className="timeline-label">
                {day.notes.length} {day.notes.length === 1 ? 'note' : 'notes'}
              </span>
              <ul className="timeline-sublist">
                {day.notes.map((note) => {
                  const noteContext = resolveContext(note.contextType, note.contextRef, context)
                  return (
                    <li key={note.id}>
                      <a className="timeline-note" href={notePath(note.id)}>
                        <NoteText text={note.text} />
                      </a>
                      <LinkCard note={note} />
                      {noteContext && (
                        <p className="note-context">
                          <span aria-hidden="true">{noteContext.icon}</span> re:{' '}
                          {noteContext.href ? (
                            <Link to={noteContext.href}>{noteContext.text}</Link>
                          ) : (
                            noteContext.text
                          )}
                        </p>
                      )}
                      <span className="timeline-detail">{formatTime(note.createdAt)}</span>
                    </li>
                  )
                })}
              </ul>
            </span>
          </li>
        )}

        {day.photos.length > 0 && (
          <li className="timeline-event" data-stream="photos">
            <span className="timeline-icon" aria-hidden="true">
              📸
            </span>
            <span>
              <span className="timeline-label">
                {day.photos.length} {day.photos.length === 1 ? 'photo' : 'photos'}
              </span>{' '}
              <Link to="/photos">in the feed</Link>
              <ul className="timeline-thumbs">
                {day.photos.map((photo) => (
                  <li key={photo.id}>
                    {/* Straight to that photo's own page. */}
                    <Link to={`/photos/${photo.id}`}>
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

function FilmEvent({ film }: { film: Film }) {
  const href = letterboxdUrl(film)
  // The year belongs to the title — "Tag (2018)" is how you say which Tag — so
  // it is part of the link text, not a fragment left outside it. Rating and
  // rewatch are notes about the viewing and go in the muted clause after it.
  // Either of those can be absent.
  const name = `${film.title}${film.year ? ` (${film.year})` : ''}`
  const detail = [stars(film.rating), film.rewatch ? 'rewatch' : null].filter(Boolean).join(' · ')

  return (
    <li className="timeline-event" data-stream="watching">
      <span className="timeline-icon" aria-hidden="true">
        🎬
      </span>
      <span>
        <span className="timeline-label">Watched</span>{' '}
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {name}
          </a>
        ) : (
          name
        )}
        {detail && <span className="timeline-detail"> · {detail}</span>}
      </span>
    </li>
  )
}

function BookEvent({ book, verb }: { book: Book; verb: 'Finished' | 'Started' }) {
  const href = hardcoverUrl(book)
  return (
    <li className="timeline-event" data-stream="reading">
      <span className="timeline-icon" aria-hidden="true">
        📚
      </span>
      <span>
        <span className="timeline-label">{verb}</span>{' '}
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {book.title}
          </a>
        ) : (
          book.title
        )}
        {book.authors && <span className="timeline-detail"> — {book.authors}</span>}
      </span>
    </li>
  )
}
