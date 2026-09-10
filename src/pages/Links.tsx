import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { LinkRow } from '../components/ReadingBits'
import { dayKey, formatDayLabel, formatNumber } from '../lib/datetime'
import { pageSchema } from '../lib/structuredData'
import { fetchOlderLinks, fetchReading, type Link as SavedLink, type ReadingBundle } from '../lib/reading'

export function Component() {
  const [bundle, setBundle] = useState<ReadingBundle | null>(null)
  const [error, setError] = useState(false)

  // No polling: links arrive when I save one, not on a timer.
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
        title="Links"
        description="Interesting links Cailin Pitt has saved — sites, tools, and one-off pages worth keeping."
        path="/links"
        jsonLd={pageSchema({
          path: '/links',
          title: 'Links',
          description: 'Interesting links Cailin Pitt has saved.',
          type: 'CollectionPage',
        })}
      />

      <h1>Links</h1>
      <p>
        Interesting things I&rsquo;ve come across &mdash; sites, tools, one-off pages worth
        remembering. Longer things I actually read go in{' '}
        <Link to="/reading/articles">articles</Link>.
        {bundle && ` ${formatNumber(bundle.counts.links ?? 0)} so far.`}
      </p>

      {error && !bundle ? (
        <p className="reading-error">Could not load links right now. Try again later.</p>
      ) : !bundle ? (
        <LinksSkeleton />
      ) : (
        <LinkLog initial={bundle.links ?? []} initialCursor={bundle.nextLinkCursor ?? null} />
      )}
    </div>
  )
}

const linkKey = (link: SavedLink) => link.id

function LinkLog({
  initial,
  initialCursor,
}: {
  initial: SavedLink[]
  initialCursor: string | null
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
      const page = await fetchOlderLinks(cursor, 20, controller.signal)
      setItems((prev) => {
        // The cursor is exclusive, but dedupe anyway.
        const seen = new Set(prev.map(linkKey))
        return [...prev, ...page.links.filter((link) => !seen.has(linkKey(link)))]
      })
      setCursor(page.nextCursor)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') setCursor(null)
    } finally {
      setLoading(false)
    }
  }, [cursor, loading])

  // Group into local calendar days, preserving the API's newest-first order.
  const days = useMemo(() => {
    const grouped: { date: string; links: SavedLink[] }[] = []
    for (const link of items) {
      const date = dayKey(link.savedAt)
      const last = grouped[grouped.length - 1]
      if (last?.date === date) last.links.push(link)
      else grouped.push({ date, links: [link] })
    }
    return grouped
  }, [items])

  return (
    <section className="reading-links" aria-labelledby="reading-links-heading">
      <h2 id="reading-links-heading" className="visually-hidden">
        Links
      </h2>

      {days.length === 0 ? (
        <p className="reading-empty">Nothing saved yet.</p>
      ) : (
        days.map((day) => (
          <div className="link-day" key={day.date}>
            <h3 className="link-day-label">
              {formatDayLabel(day.date)}
              <span className="link-day-count">
                {day.links.length} {day.links.length === 1 ? 'link' : 'links'}
              </span>
            </h3>
            <ul className="link-list">
              {day.links.map((link) => (
                <LinkRow key={link.id} link={link} />
              ))}
            </ul>
          </div>
        ))
      )}

      {cursor != null && (
        <button className="load-more" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading…' : 'Load older links'}
        </button>
      )}
    </section>
  )
}

function LinksSkeleton() {
  return (
    <div className="reading-skeleton" aria-hidden="true">
      <div className="sk-card" />
      <div className="sk-card" />
      <div className="sk-card" />
    </div>
  )
}
