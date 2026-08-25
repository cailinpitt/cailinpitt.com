import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData, useNavigate, useParams } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { addDays, dayKey, formatDayLabel, formatNumber, formatTime, keyForOffset } from '../lib/datetime'
import { imageUrl } from '../lib/images'
import { FIRST_LISTENING_YEAR } from '../lib/listeningYears'
import {
  fetchOlderCompactDays,
  fetchTimelineDay,
  fetchTimelineDays,
  type CompactDay,
  type DayHighlights,
} from '../lib/listening'
import {
  faviconUrl,
  fetchArticlesOnDate,
  fetchBooksOnDate,
  fetchOlderArticles,
  fetchOlderBooks,
  fetchReading,
  hardcoverUrl,
  type Article,
  type Book,
} from '../lib/reading'
import {
  fetchFilmsOnDate,
  fetchOlderFilms,
  fetchWatching,
  letterboxdUrl,
  stars,
  type Film,
} from '../lib/watching'
import {
  fetchActivitiesOnDate,
  fetchMoving,
  fetchOlderActivities,
  kindIcon,
  summary as activitySummary,
  type Activity,
} from '../lib/moving'
import { fetchNotes, fetchNotesOnDate, fetchOlderNotes, notePath, type Note } from '../lib/notes'
import { resolveContext, type ContextSources } from '../lib/notesContext'
import { LinkCard } from '../components/LinkCard'
import { NoteText } from '../components/NoteText'
import type { Photo } from '../lib/photos'
import type { PostSummary } from '../lib/posts'
import { concertPlace, type Concert } from '../lib/concerts'
import {
  buildTimeline,
  datedPhotos,
  onThisDay,
  TIMELINE_OG_CARD,
  timelineDayPath,
  timelineDayUrl,
  type TimelineDay,
} from '../lib/timeline'
import { pageSchema } from '../lib/structuredData'

interface TimelineData {
  posts: PostSummary[]
  photos: Photo[]
  concerts: Concert[]
}

/** Listening days pulled per page. The Worker caps /days at 14. */
const DAY_PAGE = 14
/** Stops a runaway top-up if a cursor never drains. 10 pages is ~200 items. */
const TOP_UP_LIMIT = 10

export async function loader(): Promise<TimelineData> {
  if (!import.meta.env.SSR) {
    // /timeline itself is prerendered, so a client nav there reads the baked-in static
    // loader data instead of re-running this — this branch only actually executes for
    // /timeline/:date, which isn't prerendered (dates aren't known at build time) and so
    // has no static data to read, whether hydrating a direct hit or navigating client-side.
    const { loadDatedPhotos, loadConcerts } = await import('../lib/content.client')
    const { loadPostSummaries } = await import('../lib/blogPosts.client')
    return { posts: loadPostSummaries(), photos: loadDatedPhotos(), concerts: loadConcerts() }
  }
  const { loadDatedPhotos, loadPostSummaries, loadConcerts } = await import('../lib/content.server')
  const [posts, photos, concerts] = await Promise.all([
    loadPostSummaries(),
    loadDatedPhotos(),
    loadConcerts(),
  ])
  return { posts, photos, concerts }
}

/**
 * Pulls a cursor-paged stream until it passes `floor`, so older rows aren't
 * understated. On failure, returns what it has and leaves the cursor alone
 * (instead of throwing/nulling) so one bad endpoint doesn't cost the whole
 * batch its history, and the next click retries just that stream.
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
    // Null floor means listening is exhausted, so show everything left.
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

function useTimeline(posts: PostSummary[], photos: Photo[], concerts: Concert[]) {
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

    // allSettled, not all: this page reads every Worker, so one being down
    // shouldn't blank the page — each stream fails independently instead.
    Promise.allSettled([
      // Compact projection (count + top artist/day), not the full bundle —
      // this page renders no individual track, ~93% of the bundle unused.
      fetchTimelineDays(controller.signal),
      fetchReading(controller.signal),
      fetchWatching(controller.signal),
      fetchMoving(controller.signal),
      fetchNotes(controller.signal),
    ]).then(async ([listening, reading, watching, moving, notes]) => {
      if (controller.signal.aborted) return

      // Listening's first page (14 days) is deeper than the other streams'
      // default page, so top them up to match or a day near the bottom would
      // show scrobbles but silently drop items not yet paged in.
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
      // Error only when every stream failed (no network/outage/blocker) —
      // anything less, there's still something to show.
      setError(streams.every((result) => result.status === 'rejected'))
      setReady(true)
    })

    return () => controller.abort()
  }, [])

  // Scrobbles are the densest stream, so the oldest loaded day is how far
  // back the page can honestly go.
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
          // Same bucketing buildTimeline uses, so "reached floor" means the
          // same thing here.
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
          // Matches buildTimeline's bucketing.
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
    () =>
      buildTimeline({ days, articles, books, films, activities, posts, photos, notes, concerts, floor }),
    [activities, articles, books, concerts, days, films, floor, notes, photos, posts],
  )

  return { timeline, ready, error, loading, hasMore: before != null, loadMore }
}

export function Component() {
  const { posts, photos, concerts } = useLoaderData() as TimelineData
  const { date } = useParams<{ date?: string }>()

  return date ? (
    <TimelineDayView date={date} posts={posts} photos={photos} concerts={concerts} />
  ) : (
    <TimelineFeed posts={posts} photos={photos} concerts={concerts} />
  )
}

// `new Date('YYYY-MM-DD')` parses as UTC midnight, not local — go through the
// numeric constructor to get the viewer's own local day, matching dayKey().
function localDayRange(date: string): [number, number] {
  const [y, m, d] = date.split('-').map(Number)
  const start = new Date(y, m - 1, d).getTime() / 1000
  return [start, start + 86_400]
}

interface DayFetchState {
  day: TimelineDay | null
  highlights: DayHighlights | null
  ready: boolean
  error: boolean
}

const EMPTY_STATE: DayFetchState = { day: null, highlights: null, ready: false, error: false }

// One indexed request per stream, scoped to `date` — unlike useTimeline, no paging.
function useTimelineDay(
  date: string,
  posts: PostSummary[],
  photos: Photo[],
  concerts: Concert[],
): DayFetchState {
  const [state, setState] = useState<DayFetchState>(EMPTY_STATE)

  useEffect(() => {
    setState(EMPTY_STATE)
    const controller = new AbortController()
    const [from, to] = localDayRange(date)

    Promise.allSettled([
      fetchTimelineDay(date, controller.signal),
      fetchArticlesOnDate(from, to, controller.signal),
      fetchBooksOnDate(date, controller.signal),
      fetchFilmsOnDate(date, controller.signal),
      fetchActivitiesOnDate(date, controller.signal),
      fetchNotesOnDate(from, to, controller.signal),
    ]).then(([listening, articles, books, films, activities, notes]) => {
      if (controller.signal.aborted) return
      const results = [listening, articles, books, films, activities, notes]
      if (results.every((r) => r.status === 'rejected')) {
        setState({ day: null, highlights: null, ready: true, error: true })
        return
      }

      const timeline = buildTimeline({
        days: listening.status === 'fulfilled' && listening.value ? [listening.value] : [],
        articles: articles.status === 'fulfilled' ? articles.value : [],
        books: books.status === 'fulfilled' ? books.value : [],
        films: films.status === 'fulfilled' ? films.value : [],
        activities: activities.status === 'fulfilled' ? activities.value : [],
        posts: posts.filter((p) => p.date.slice(0, 10) === date),
        photos: datedPhotos(photos).filter((p) => p.date.slice(0, 10) === date),
        notes: notes.status === 'fulfilled' ? notes.value : [],
        concerts: concerts.filter((c) => c.date === date),
        floor: null,
      })
      setState({
        day: timeline[0] ?? null,
        highlights: listening.status === 'fulfilled' ? listening.value : null,
        ready: true,
        error: false,
      })
    })

    return () => controller.abort()
  }, [date, posts, photos, concerts])

  return state
}

// Random day picks anywhere from the first year listening was archived to today — see
// FIRST_LISTENING_YEAR in lib/listeningYears.ts (also what /listening/<year>'s static
// paths are built from, so it's the same "how far back does this site's data go" answer).
function randomDate(): string {
  const start = Date.UTC(FIRST_LISTENING_YEAR, 0, 1)
  const uts = start + Math.random() * (Date.now() - start)
  return new Date(uts).toISOString().slice(0, 10)
}

function RandomDayLink({ className }: { className?: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" className={className} onClick={() => navigate(timelineDayPath(randomDate()))}>
      🎲 Random day
    </button>
  )
}

function TimelineDayNav({ date }: { date: string }) {
  const prev = addDays(date, -1)
  const next = addDays(date, 1)

  return (
    <nav className="timeline-day-nav" aria-label="Day">
      <Link to={timelineDayPath(prev)}>← {formatDayLabel(prev)}</Link>
      <RandomDayLink className="timeline-day-nav-random" />
      {next <= keyForOffset(0) && <Link to={timelineDayPath(next)}>{formatDayLabel(next)} →</Link>}
    </nav>
  )
}

function TimelineDayView({
  date,
  posts,
  photos,
  concerts,
}: {
  date: string
  posts: PostSummary[]
  photos: Photo[]
  concerts: Concert[]
}) {
  const { day, highlights, ready, error } = useTimelineDay(date, posts, photos, concerts)
  const contextSources: ContextSources = { posts, photos, activities: day?.activities ?? [] }
  const label = formatDayLabel(date)

  return (
    <div className="timeline">
      <Seo
        title={label}
        description={`What Cailin Pitt listened to, read, watched, saw, moved, wrote, noted, and photographed on ${label}.`}
        path={timelineDayPath(date)}
        image={TIMELINE_OG_CARD}
      />
      <p className="timeline-back">
        <Link to="/timeline">← Timeline</Link>
      </p>
      <TimelineDayNav date={date} />

      {error ? (
        <p className="timeline-error">Could not load the timeline right now. Try again later.</p>
      ) : !ready ? (
        <div className="timeline-skeleton" aria-hidden="true">
          <div className="sk-block" />
        </div>
      ) : day ? (
        <>
          {(highlights?.milestone || highlights?.returning) && (
            <ul className="timeline-highlights">
              {highlights.milestone && (
                <li>
                  🎉 Scrobble #{formatNumber(highlights.milestone.n)} — {highlights.milestone.track},{' '}
                  {highlights.milestone.artist}
                </li>
              )}
              {highlights.returning && (
                <li>
                  🔁 First {highlights.returning.name} play in{' '}
                  {formatNumber(highlights.returning.gapDays)} days
                </li>
              )}
            </ul>
          )}
          <ol className="timeline-days">
            <TimelineRow day={day} context={contextSources} />
          </ol>
        </>
      ) : (
        <p className="timeline-error">Nothing logged for this day.</p>
      )}
    </div>
  )
}

function TimelineJump() {
  const navigate = useNavigate()
  const id = useId()
  const [date, setDate] = useState('')

  return (
    <form
      className="timeline-jump"
      onSubmit={(e) => {
        e.preventDefault()
        if (date) navigate(timelineDayPath(date))
      }}
    >
      <label htmlFor={id}>Jump to a day</label>
      <input
        id={id}
        type="date"
        max={keyForOffset(0)}
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <button type="submit" disabled={!date}>
        Go
      </button>
      <RandomDayLink className="timeline-jump-random" />
    </form>
  )
}

function TimelineFeed({ posts, photos, concerts }: TimelineData) {
  const { timeline, ready, error, loading, hasMore, loadMore } = useTimeline(posts, photos, concerts)

  // Already-loaded activities, for resolveContext() to search when a note
  // references one (see notesContext.ts).
  const activities = useMemo(() => timeline.flatMap((day) => day.activities), [timeline])
  const contextSources: ContextSources = { posts, photos, activities }

  // Today's own row is already the top of the list, so exclude it from "on
  // this day" (see onThisDay() in lib/timeline.ts).
  const monthDay = keyForOffset(0).slice(5)
  const otd = useMemo(
    () => onThisDay(timeline, monthDay).filter((day) => day.date !== keyForOffset(0)),
    [timeline, monthDay],
  )

  return (
    <div className="timeline">
      <Seo
        title="Timeline"
        description="Everything Cailin Pitt listened to, read, watched, saw, moved, wrote, noted, and photographed, day by day."
        path="/timeline"
        jsonLd={pageSchema({
          path: '/timeline',
          title: 'Timeline',
          description:
            'Everything Cailin Pitt listened to, read, watched, saw, moved, wrote, noted, and photographed, day by day.',
          type: 'CollectionPage',
        })}
      />
      <h1>Timeline</h1>
      <p>
        One row per day, pulling together <Link to="/listening">listening</Link>,{' '}
        <Link to="/reading">reading</Link>, <Link to="/watching">watching</Link>,{' '}
        <Link to="/concerts">concerts</Link>, <Link to="/moving">moving</Link>,{' '}
        <Link to="/blog">blog</Link>, <Link to="/notes">notes</Link>, and{' '}
        <Link to="/photos">photos</Link>.
      </p>

      <TimelineJump />

      {/* error means every stream failed; set alongside ready, not instead of it. */}
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

function TimelineDayLink({ date }: { date: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(timelineDayUrl(date))
      setCopied(true)
    } catch {
      // clipboard unavailable; the link still navigates
    }
  }

  return (
    <Link
      to={timelineDayPath(date)}
      className="timeline-permalink"
      onClick={copy}
      aria-label={`Copy link to ${formatDayLabel(date)}`}
    >
      #
      {copied && (
        <span className="timeline-permalink-copied" role="status" aria-live="polite">
          Copied
        </span>
      )}
    </Link>
  )
}

function TimelineRow({ day, context }: { day: TimelineDay; context?: ContextSources }) {
  return (
    <li className="timeline-day">
      <h2 className="timeline-date">
        <span className="timeline-date-label">
          {formatDayLabel(day.date)}
          <TimelineDayLink date={day.date} />
        </span>
        <span className="timeline-year">{day.date.slice(0, 4)}</span>
      </h2>
      <ul className="timeline-events">
        {day.scrobbles > 0 && (
          <li className="timeline-event" data-stream="listening">
            <span className="timeline-icon" aria-hidden="true">
              🎧
            </span>
            <span>
              <Link to="/listening">
                {formatNumber(day.scrobbles)} {day.scrobbles === 1 ? 'scrobble' : 'scrobbles'}
              </Link>
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

        {day.concerts.map((concert) => (
          <ConcertEvent key={concert.id} concert={concert} />
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
  // Year is part of the title text ("Tag (2018)"); rating/rewatch are notes
  // about the viewing and go in the muted clause after, either optional.
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

function ConcertEvent({ concert }: { concert: Concert }) {
  const lineup = concert.artists.join(' / ')
  const place = concertPlace(concert)

  return (
    <li className="timeline-event" data-stream="concerts">
      <span className="timeline-icon" aria-hidden="true">
        🎤
      </span>
      <span>
        <span className="timeline-label">Saw</span>{' '}
        {concert.url ? (
          <a href={concert.url} target="_blank" rel="noopener noreferrer">
            {lineup}
          </a>
        ) : (
          lineup
        )}
        {place && <span className="timeline-detail"> · {place}</span>}
        {concert.name && <span className="timeline-detail"> · {concert.name}</span>}
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
