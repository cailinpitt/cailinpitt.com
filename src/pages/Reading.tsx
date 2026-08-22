import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { CurlHint } from '../components/CurlHint'
import { StatTile } from '../components/ListeningBits'
import { BookCard } from '../components/ReadingBits'
import { pageSchema } from '../lib/structuredData'
import { booksByYear, fetchOlderBooks, fetchReading, type Book, type ReadingBundle } from '../lib/reading'

export function Component() {
  const [bundle, setBundle] = useState<ReadingBundle | null>(null)
  const [error, setError] = useState(false)

  // No polling: books sync once a day.
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
        description="Books Cailin Pitt has been reading, and when."
        path="/reading"
        jsonLd={pageSchema({
          path: '/reading',
          title: 'Reading',
          description: 'Books Cailin Pitt has been reading, and when.',
          type: 'CollectionPage',
        })}
      />

      <h1>Reading</h1>
      <p>
        Books come from my{' '}
        <a href="https://hardcover.app" target="_blank" rel="noopener noreferrer">
          Hardcover
        </a>
        {' '}account.
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
            </dl>
          </section>

          {bundle.currentlyReading.length > 0 && (
            <section className="reading-now" aria-labelledby="reading-now-heading">
              <h2 id="reading-now-heading" className="eyebrow">
                📖 Currently reading
              </h2>
              <ul className="book-grid">
                {bundle.currentlyReading.map((book) => (
                  <BookCard key={`${book.userBookId}-${book.readId}`} book={book} dateLabel="started" />
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
      )}
    </div>
  )
}

const bookKey = (book: Book) => `${book.userBookId}-${book.readId}`

function FinishedBooks({
  initial,
  initialCursor,
  total,
}: {
  initial: Book[]
  initialCursor: string | null
  total: number
}) {
  const [items, setItems] = useState(initial)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  const loadMore = useCallback(async () => {
    if (cursor == null || loading) return
    setLoading(true)
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const page = await fetchOlderBooks(cursor, 24, controller.signal)
      setItems((prev) => {
        // The cursor is exclusive, but dedupe anyway — something added between
        // two requests could otherwise land on both pages.
        const seen = new Set(prev.map(bookKey))
        return [...prev, ...page.books.filter((book) => !seen.has(bookKey(book)))]
      })
      setCursor(page.nextCursor)
    } catch (err) {
      // Stop offering the button rather than looping on a broken endpoint.
      if ((err as Error)?.name !== 'AbortError') setCursor(null)
    } finally {
      setLoading(false)
    }
  }, [cursor, loading])

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

function ReadingSkeleton() {
  return (
    <div className="reading-skeleton" aria-hidden="true">
      <div className="sk-tiles">
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
