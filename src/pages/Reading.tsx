import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { CurlHint } from '../components/CurlHint'
import { StatTile } from '../components/ListeningBits'
import { ArticleCard, BookCard } from '../components/ReadingBits'
import { dayKey, formatDayLabel } from '../lib/datetime'
import { pageSchema } from '../lib/structuredData'
import {
  booksByYear,
  fetchOlderArticles,
  fetchOlderBooks,
  fetchReading,
  type Article,
  type Book,
  type ReadingBundle,
} from '../lib/reading'

type Tab = 'books' | 'articles'

export function Component() {
  const [bundle, setBundle] = useState<ReadingBundle | null>(null)
  const [error, setError] = useState(false)

  // The tab lives in the url so a link can point straight at the articles, and
  // so this can become /books and /articles later without changing anything a
  // reader has bookmarked. Safe against hydration mismatches because the tabs
  // only render once `bundle` is set, which never happens during prerender.
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'articles' ? 'articles' : 'books'
  const setTab = (next: Tab) =>
    setParams(next === 'books' ? {} : { tab: next }, { replace: true })

  // Unlike /listening there is no polling: books sync once a day and articles
  // arrive by email, so nothing here changes while the page is open.
  useEffect(() => {
    const controller = new AbortController()
    fetchReading(controller.signal)
      .then(setBundle)
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(true)
      })
    return () => controller.abort()
  }, [])

  return (
    <div className="reading">
      <Seo
        title="Reading"
        description="Books and articles Cailin Pitt has been reading, and when."
        path="/reading"
        jsonLd={pageSchema({
          path: '/reading',
          title: 'Reading',
          description: 'Books and articles Cailin Pitt has been reading, and when.',
          type: 'CollectionPage',
        })}
      />

      <h1>Reading</h1>
      <p>
        Books come from{' '}
        <a href="https://hardcover.app" target="_blank" rel="noopener noreferrer">
          Hardcover
        </a>
        . Articles are ones I saved as I read them.
      </p>
      <CurlHint command="curl reading.cailinpitt.com" />

      {error && !bundle ? (
        <p className="reading-error">Could not load reading data right now. Try again later.</p>
      ) : !bundle ? (
        <ReadingSkeleton />
      ) : (
        <>
          <section className="reading-stats" aria-labelledby="reading-stats-heading">
            <h2 id="reading-stats-heading" className="visually-hidden">
              Totals
            </h2>
            <dl className="stat-tiles">
              <StatTile label="Books read" value={bundle.counts.booksRead} />
              <StatTile label="This year" value={bundle.counts.booksThisYear} />
              <StatTile label="Pages this year" value={bundle.counts.pagesThisYear} />
              <StatTile label="Articles saved" value={bundle.counts.articles} />
            </dl>
          </section>

          {/* Books and articles are peers, so they share top billing rather than
              stacking — the article log used to sit below the whole book history,
              where nobody would ever scroll to find it. The counts on the tabs are
              what advertise that the other half exists. */}
          <div className="segmented reading-tabs" role="tablist" aria-label="Reading">
            {(['books', 'articles'] as Tab[]).map((key) => (
              <button
                key={key}
                role="tab"
                id={`reading-tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`reading-panel-${key}`}
                className={tab === key ? 'active' : undefined}
                onClick={() => setTab(key)}
              >
                {key === 'books' ? '📚 Books' : '🔗 Articles'}
                <span className="segmented-count">
                  {key === 'books' ? bundle.counts.booksRead : bundle.counts.articles}
                </span>
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`reading-panel-${tab}`}
            aria-labelledby={`reading-tab-${tab}`}
            // Remount on tab change so each panel's pagination starts fresh
            // rather than restoring a half-loaded list from last time.
            key={tab}
          >
            {tab === 'books' ? (
              <>
                {bundle.currentlyReading.length > 0 && (
                  <section className="reading-now" aria-labelledby="reading-now-heading">
                    <h2 id="reading-now-heading" className="eyebrow">
                      📖 Currently reading
                    </h2>
                    <ul className="book-grid">
                      {bundle.currentlyReading.map((book) => (
                        <BookCard
                          key={`${book.userBookId}-${book.readId}`}
                          book={book}
                          dateLabel="started"
                        />
                      ))}
                    </ul>
                  </section>
                )}
                <FinishedBooks
                  initial={bundle.finishedBooks}
                  initialCursor={bundle.nextBookCursor}
                  total={bundle.counts.booksRead}
                />
              </>
            ) : (
              <ArticleLog initial={bundle.articles} initialCursor={bundle.nextCursor} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---- pagination ----------------------------------------------------------

/**
 * Shared "load older" behavior for the two paginated sections.
 *
 * Both lists are newest-first behind an opaque cursor, so the only things that
 * differ are which endpoint to call and how to key an item for deduping.
 */
function usePaginated<T>(
  initial: T[],
  initialCursor: string | null,
  load: (cursor: string, signal: AbortSignal) => Promise<{ items: T[]; nextCursor: string | null }>,
  keyOf: (item: T) => string,
) {
  const [items, setItems] = useState(initial)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  // Held in a ref so an inline `load` closure doesn't re-create loadMore.
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => () => controllerRef.current?.abort(), [])

  const loadMore = useCallback(async () => {
    if (cursor == null || loading) return
    setLoading(true)
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const page = await loadRef.current(cursor, controller.signal)
      setItems((prev) => {
        // The cursor is exclusive, but dedupe anyway — something added between
        // two requests could otherwise land on both pages.
        const seen = new Set(prev.map(keyOf))
        return [...prev, ...page.items.filter((item) => !seen.has(keyOf(item)))]
      })
      setCursor(page.nextCursor)
    } catch (err) {
      // Stop offering the button rather than looping on a broken endpoint.
      if ((err as Error)?.name !== 'AbortError') setCursor(null)
    } finally {
      setLoading(false)
    }
  }, [cursor, loading, keyOf])

  return { items, cursor, loading, loadMore }
}

// Module-level so they're referentially stable across renders.
const bookKey = (book: Book) => `${book.userBookId}-${book.readId}`
const articleKey = (article: Article) => article.id

// ---- finished books ------------------------------------------------------

function FinishedBooks({
  initial,
  initialCursor,
  total,
}: {
  initial: Book[]
  initialCursor: string | null
  total: number
}) {
  const { items, cursor, loading, loadMore } = usePaginated(
    initial,
    initialCursor,
    async (cursor, signal) => {
      const page = await fetchOlderBooks(cursor, 24, signal)
      return { items: page.books, nextCursor: page.nextCursor }
    },
    bookKey,
  )

  const years = useMemo(() => booksByYear(items), [items])
  if (!items.length) return null

  return (
    <section className="reading-finished" aria-labelledby="reading-finished-heading">
      <h2 id="reading-finished-heading" className="eyebrow">
        📚 Finished
      </h2>
      {years.map(({ year, books }) => (
        <div className="book-year" key={year}>
          <h3 className="book-year-label">
            {year}
            <span className="book-year-count">
              {books.length} {books.length === 1 ? 'book' : 'books'}
            </span>
          </h3>
          <ul className="book-grid">
            {books.map((book) => (
              <BookCard key={bookKey(book)} book={book} dateLabel="finished" />
            ))}
          </ul>
        </div>
      ))}

      {cursor != null && (
        <>
          <p className="load-progress">
            Showing {items.length} of {total}
          </p>
          <button className="load-more" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load older books'}
          </button>
        </>
      )}
    </section>
  )
}

// ---- article log ---------------------------------------------------------

function ArticleLog({
  initial,
  initialCursor,
}: {
  initial: Article[]
  initialCursor: string | null
}) {
  const { items, cursor, loading, loadMore } = usePaginated(
    initial,
    initialCursor,
    async (cursor, signal) => {
      const page = await fetchOlderArticles(cursor, 20, signal)
      return { items: page.articles, nextCursor: page.nextCursor }
    },
    articleKey,
  )

  // Group into local calendar days, preserving the API's newest-first order.
  const days = useMemo(() => {
    const grouped: { date: string; articles: Article[] }[] = []
    for (const article of items) {
      const date = dayKey(article.readAt)
      const last = grouped[grouped.length - 1]
      if (last?.date === date) last.articles.push(article)
      else grouped.push({ date, articles: [article] })
    }
    return grouped
  }, [items])

  return (
    <section className="reading-articles" aria-labelledby="reading-articles-heading">
      <h2 id="reading-articles-heading" className="eyebrow">
        🔗 Articles
      </h2>

      {days.length === 0 ? (
        <p className="reading-empty">Nothing saved yet.</p>
      ) : (
        days.map((day) => (
          <div className="article-day" key={day.date}>
            <h3 className="article-day-label">
              {formatDayLabel(day.date)}
              <span className="article-day-count">
                {day.articles.length} {day.articles.length === 1 ? 'article' : 'articles'}
              </span>
            </h3>
            <ul className="article-list">
              {day.articles.map((article) => (
                <ArticleCard key={article.id} article={article} />
              ))}
            </ul>
          </div>
        ))
      )}

      {cursor != null && (
        <button className="load-more" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading…' : 'Load older articles'}
        </button>
      )}
    </section>
  )
}

// ---- loading state -------------------------------------------------------

function ReadingSkeleton() {
  return (
    <div className="reading-skeleton" aria-hidden="true">
      <div className="sk-tiles">
        <div className="sk-tile" />
        <div className="sk-tile" />
        <div className="sk-tile" />
        <div className="sk-tile" />
      </div>
      <div className="sk-block" />
      <div className="sk-card" />
      <div className="sk-card" />
    </div>
  )
}
