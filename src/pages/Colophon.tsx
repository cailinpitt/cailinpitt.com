import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { StatTile } from '../components/ListeningBits'
import { PostHistory, useHistoryPanel } from '../components/PostHistory'
import { PostSource } from '../components/PostSource'
import { colophonPage, fillTemplate } from '../lib/colophon'
import type { PostHistory as PostHistoryData } from '../lib/history'
import { fetchNow } from '../lib/listening'
import { fetchReading } from '../lib/reading'
import { fetchWatching } from '../lib/watching'
import { fetchMoving } from '../lib/moving'
import { pageSchema } from '../lib/structuredData'

/** Where this page's own source is published — see scripts/generate-markdown.mjs. */
const SOURCE_FILE = '/colophon.md'

// The prose lives in content/colophon.md; everything here is the numbers it
// quotes plus the tiles above it, which are live and can't be written down.

/** Counted at build time; `posts`/`words` feed the tiles, the rest are quoted
 * by the prose in content/colophon.md as {{placeholders}}. */
interface ColophonData {
  posts: number
  words: number
  photos: number
  years: number
  located: number
  /** What git knows about content/colophon.md; null outside a git checkout. */
  history: (PostHistoryData & { file: string }) | null
  /** Repo web URL, for linking commits. */
  repo: string | null
}

export async function loader(): Promise<ColophonData | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    const { loadPhotos, loadPostSummaries } = await import('../lib/content.client')
    return { ...summarize(loadPostSummaries(), loadPhotos()), ...(await provenance()) }
  }
  const { loadPhotos, loadPostSummaries } = await import('../lib/content.server')
  const [posts, photos] = await Promise.all([loadPostSummaries(), loadPhotos()])
  return { ...summarize(posts, photos), ...(await provenance()) }
}

// Imported here, not at the top, so it lands in its own chunk — the
// production client returns above without ever loading it.
async function provenance() {
  const { history, repo } = await import('virtual:post-history')
  return { history: history['/colophon'] ?? null, repo }
}

type ColophonCounts = Omit<ColophonData, 'history' | 'repo'>

function summarize(
  posts: { words: number }[],
  photos: { year: string; exif?: { place?: number[] } }[],
): ColophonCounts {
  return {
    posts: posts.length,
    words: posts.reduce((total, post) => total + post.words, 0),
    photos: photos.length,
    years: new Set(photos.map((photo) => photo.year)).size,
    located: photos.filter((photo) => photo.exif?.place?.length === 2).length,
  }
}

// The five counters the site itself doesn't know: scrobbles, books, and films
// live in the Workers' databases, so each tile simply doesn't render until its
// number lands. A Worker being down costs this page its tiles and nothing else.
function LiveTiles() {
  const [scrobbles, setScrobbles] = useState<number | null>(null)
  const [reading, setReading] = useState<{ books: number; articles: number } | null>(null)
  const [watching, setWatching] = useState<{ films: number; rewatches: number } | null>(null)
  const [moving, setMoving] = useState<{ miles: number; rides: number; lifts: number } | null>(
    null,
  )

  useEffect(() => {
    const controller = new AbortController()
    void fetchNow(controller.signal)
      .then((now) => setScrobbles(now.totalScrobbles ?? null))
      .catch(() => {})
    void fetchReading(controller.signal)
      .then((bundle) =>
        setReading({ books: bundle.counts.booksRead, articles: bundle.counts.articles }),
      )
      .catch(() => {})
    void fetchWatching(controller.signal)
      .then((bundle) =>
        setWatching({ films: bundle.counts.films, rewatches: bundle.counts.rewatches }),
      )
      .catch(() => {})
    void fetchMoving(controller.signal)
      .then((bundle) =>
        setMoving({
          miles: Math.round(bundle.counts.distanceMi),
          rides: bundle.counts.rides,
          lifts: bundle.counts.lifts,
        }),
      )
      .catch(() => {})
    return () => controller.abort()
  }, [])

  return (
    <>
      {scrobbles != null && <StatTile label="Scrobbles" value={scrobbles} />}
      {reading && <StatTile label="Books read" value={reading.books} />}
      {reading && <StatTile label="Articles saved" value={reading.articles} />}
      {watching && <StatTile label="Films watched" value={watching.films} />}
      {watching && <StatTile label="Films rewatched" value={watching.rewatches} />}
      {/* Three, not two: the grid is three columns and the tile count has to
          stay a multiple of it or the last row goes ragged. */}
      {moving && <StatTile label="Miles" value={moving.miles} />}
      {moving && <StatTile label="Rides" value={moving.rides} />}
      {moving && <StatTile label="Lifts" value={moving.lifts} />}
    </>
  )
}

// Keep root-relative links client-side (a full reload per link would be a
// step back from the hand-written JSX this replaced); external/anchor/mailto fall through.
const markdownComponents = {
  a: ({
    node: _node,
    href,
    children,
    ...props
  }: {
    node?: unknown
    href?: string
    children?: ReactNode
  }) =>
    href?.startsWith('/') ? (
      <Link to={href} {...props}>
        {children}
      </Link>
    ) : (
      <a href={href} {...props}>
        {children}
      </a>
    ),
}

export function Component() {
  const data = useLoaderData() as ColophonData
  const { history, repo } = data
  const [showSource, setShowSource] = useState(false)
  const panel = useHistoryPanel()

  const counts: ColophonCounts = useMemo(
    () => ({
      posts: data.posts,
      words: data.words,
      photos: data.photos,
      years: data.years,
      located: data.located,
    }),
    [data],
  )
  const body = useMemo(() => fillTemplate(colophonPage.body, { ...counts }), [counts])

  return (
    <>
      <Seo
        title={colophonPage.title}
        description={colophonPage.description}
        path="/colophon"
        jsonLd={pageSchema({
          path: '/colophon',
          title: colophonPage.title,
          description: colophonPage.description,
        })}
        markdownPath={SOURCE_FILE}
      />
      <article className="post">
        <header className="post-header">
          <h1>{colophonPage.title}</h1>
          {colophonPage.lead && <p>{colophonPage.lead}</p>}
        </header>

        <div className="post-source-bar">
          {/* Unfilled body — matches what content/colophon.md and the published
              .md contain, before counts are substituted in. */}
          <PostSource
            body={colophonPage.body}
            file={SOURCE_FILE}
            open={showSource}
            onToggle={setShowSource}
          />
          {history && (
            <a href="#history" onClick={panel.openFromLink}>
              History
            </a>
          )}
        </div>

        {showSource ? (
          <pre className="post-source">{colophonPage.body}</pre>
        ) : (
          <div className="post-body">
            <dl className="stat-tiles is-compact">
              <StatTile label="Posts" value={data.posts} />
              <StatTile label="Words" value={data.words} />
              <StatTile label="Photos" value={data.photos} />
              <StatTile label="Photo years" value={data.years} />
              <LiveTiles />
            </dl>
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {body}
            </Markdown>
          </div>
        )}
      </article>
      {history && (
        <PostHistory history={history} repo={repo} open={panel.open} onToggle={panel.setOpen} />
      )}
    </>
  )
}
