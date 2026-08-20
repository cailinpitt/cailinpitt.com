import { useCallback, useEffect, useRef, useState } from 'react'
import { CurlHint } from '../components/CurlHint'
import { GuestbookForm } from '../components/GuestbookForm'
import { Seo } from '../components/Seo'
import { formatNumber, formatRelative } from '../lib/datetime'
import {
  displayHost,
  fetchGuestbook,
  fetchOlderEntries,
  flagEmoji,
  type Entry,
} from '../lib/guestbook'
import { pageSchema } from '../lib/structuredData'

const DESCRIPTION = 'Sign Cailin Pitt’s guestbook, or read what other people wrote.'

export function Component() {
  const [page, setPage] = useState<{ entries: Entry[]; nextCursor: string | null; total: number } | null>(
    null,
  )
  const [error, setError] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchGuestbook(controller.signal)
      .then(setPage)
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(true)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => () => controllerRef.current?.abort(), [])

  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const older = await fetchOlderEntries(cursor, 25, controller.signal)
      setPage((prev) => {
        if (!prev) return prev
        // The cursor is exclusive, but dedupe anyway: someone signing between
        // two requests could otherwise land on both pages.
        const seen = new Set(prev.entries.map((e) => e.id))
        return {
          entries: [...prev.entries, ...older.entries.filter((e) => !seen.has(e.id))],
          nextCursor: older.nextCursor,
          total: older.total,
        }
      })
    } catch (err) {
      // Stop offering the button rather than looping on a broken endpoint.
      if ((err as Error)?.name !== 'AbortError') {
        setPage((prev) => (prev ? { ...prev, nextCursor: null } : prev))
      }
    } finally {
      setLoadingMore(false)
    }
  }, [page?.nextCursor, loadingMore])

  // Puts a just-signed entry at the top without refetching: the read endpoint's
  // 30s edge cache would often hide it, reading as "it didn't work". The POST
  // response carries the stored row, so this shows the real thing, not a guess.
  const onSigned = useCallback((entry: Entry) => {
    setPage((prev) =>
      prev
        ? { ...prev, entries: [entry, ...prev.entries], total: prev.total + 1 }
        : { entries: [entry], nextCursor: null, total: 1 },
    )
  }, [])

  return (
    <div className="guestbook">
      <Seo
        title="Guestbook"
        description={DESCRIPTION}
        path="/guestbook"
        jsonLd={pageSchema({
          path: '/guestbook',
          title: 'Guestbook',
          description: DESCRIPTION,
          type: 'CollectionPage',
        })}
      />

      <h1>Guestbook</h1>
      <p>
        👋 Say hello!
      </p>
      <CurlHint command="curl guestbook.cailinpitt.com" />

      <GuestbookForm onSigned={onSigned} />

      {error && !page ? (
        <p className="guestbook-load-error">
          Could not load the guestbook right now. Try again later.
        </p>
      ) : !page ? (
        <GuestbookSkeleton />
      ) : (
        <section className="guestbook-entries" aria-labelledby="guestbook-entries-heading">
          <h2 id="guestbook-entries-heading">
            {page.total === 0
              ? 'No entries yet'
              : `${formatNumber(page.total)} ${page.total === 1 ? 'entry' : 'entries'}`}
          </h2>

          {page.total === 0 ? (
            <p className="guestbook-empty">Nobody has signed it yet. You could be first.</p>
          ) : (
            <ol className="guestbook-list">
              {page.entries.map((entry) => (
                <GuestbookEntry key={entry.id} entry={entry} />
              ))}
            </ol>
          )}

          {page.nextCursor && (
            <button className="load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load older entries'}
            </button>
          )}
        </section>
      )}
    </div>
  )
}

function GuestbookEntry({ entry }: { entry: Entry }) {
  const flag = flagEmoji(entry.country)
  return (
    <li className="guestbook-entry">
      <div className="guestbook-byline">
        {/* Rendered as a text node, never markup — a message is only ever what
            was typed. `ugc`/`nofollow` mean the link passes no ranking signal. */}
        {entry.website ? (
          <a
            className="guestbook-name"
            href={entry.website}
            target="_blank"
            rel="nofollow ugc noopener noreferrer"
          >
            {entry.name}
          </a>
        ) : (
          <span className="guestbook-name">{entry.name}</span>
        )}

        {entry.location && <span className="guestbook-location">{entry.location}</span>}
        {flag && (
          // The code, not the country name — an emoji flag alone reads as
          // gibberish to a screen reader, and this is decoration either way.
          <span className="guestbook-flag" title={entry.country ?? undefined} aria-hidden="true">
            {flag}
          </span>
        )}

        <time className="guestbook-time" dateTime={new Date(entry.createdAt * 1000).toISOString()}>
          {formatRelative(entry.createdAt)}
        </time>
      </div>

      <p className="guestbook-message">{entry.message}</p>

      {entry.website && (
        <p className="guestbook-site">
          <a href={entry.website} target="_blank" rel="nofollow ugc noopener noreferrer">
            {displayHost(entry.website)}
          </a>
        </p>
      )}
    </li>
  )
}

function GuestbookSkeleton() {
  return (
    <div className="guestbook-skeleton" aria-hidden="true">
      <div className="sk-block" />
      <div className="sk-card" />
      <div className="sk-card" />
      <div className="sk-card" />
    </div>
  )
}
