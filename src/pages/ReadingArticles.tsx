import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { ArticleCard } from '../components/ReadingBits'
import { dayKey, formatDayLabel, formatNumber } from '../lib/datetime'
import { pageSchema } from '../lib/structuredData'
import { fetchOlderArticles, fetchReading, type Article, type ReadingBundle } from '../lib/reading'

export function Component() {
  const [bundle, setBundle] = useState<ReadingBundle | null>(null)
  const [error, setError] = useState(false)

  // No polling: articles arrive by email, not on a timer.
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
        title="Articles"
        description="Articles Cailin Pitt has saved as he read them."
        path="/reading/articles"
        jsonLd={pageSchema({
          path: '/reading/articles',
          title: 'Articles',
          description: 'Articles Cailin Pitt has saved as he read them.',
          type: 'CollectionPage',
        })}
      />

      <h1>Articles</h1>
      <p>
        Articles I enjoyed that I saved after reading them. There are
        {bundle && `  ${formatNumber(bundle.counts.articles)} so far`}.
      </p>

      {error && !bundle ? (
        <p className="reading-error">Could not load reading data right now. Try again later.</p>
      ) : !bundle ? (
        <ReadingArticlesSkeleton />
      ) : (
        <ArticleLog initial={bundle.articles} initialCursor={bundle.nextCursor} />
      )}
    </div>
  )
}

const articleKey = (article: Article) => article.id

function ArticleLog({
  initial,
  initialCursor,
}: {
  initial: Article[]
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
      const page = await fetchOlderArticles(cursor, 20, controller.signal)
      setItems((prev) => {
        // The cursor is exclusive, but dedupe anyway — something added between
        // two requests could otherwise land on both pages.
        const seen = new Set(prev.map(articleKey))
        return [...prev, ...page.articles.filter((article) => !seen.has(articleKey(article)))]
      })
      setCursor(page.nextCursor)
    } catch (err) {
      // Stop offering the button rather than looping on a broken endpoint.
      if ((err as Error)?.name !== 'AbortError') setCursor(null)
    } finally {
      setLoading(false)
    }
  }, [cursor, loading])

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
      <h2 id="reading-articles-heading" className="visually-hidden">
        Articles
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

function ReadingArticlesSkeleton() {
  return (
    <div className="reading-skeleton" aria-hidden="true">
      <div className="sk-card" />
      <div className="sk-card" />
      <div className="sk-card" />
    </div>
  )
}
