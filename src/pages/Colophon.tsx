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
import { pageSchema } from '../lib/structuredData'

/** Where this page's own source is published — see scripts/generate-markdown.mjs. */
const SOURCE_FILE = '/colophon.md'

// The prose lives in content/colophon.md; everything here is the numbers it
// quotes and the tiles above it, which are live and can't be written down.

/**
 * Counted at build time from the same content the pages are rendered from.
 * `posts` and `words` feed the tiles; the rest are quoted by the prose in
 * content/colophon.md as {{placeholders}}.
 */
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

/**
 * Imported here rather than at the top of the file so it lands in its own chunk:
 * the production client returns above without ever loading it, and the history
 * of every post has no business in this page's bundle.
 */
async function provenance() {
  const { history, repo } = await import('virtual:post-history')
  return { history: history['/colophon'] ?? null, repo }
}

/** The counters, which are also what the prose quotes as {{placeholders}}. */
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

/**
 * The three counters the site itself doesn't know.
 *
 * Everything else on this page is compiled in, but scrobbles and books live in
 * the Workers' databases — so they're fetched here the way /listening and
 * /reading fetch theirs, and each tile simply doesn't render until its number
 * lands. A Worker being down costs this page three tiles and nothing else.
 */
function LiveTiles() {
  const [scrobbles, setScrobbles] = useState<number | null>(null)
  const [reading, setReading] = useState<{ books: number; articles: number } | null>(null)

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
    return () => controller.abort()
  }, [])

  return (
    <>
      {scrobbles != null && <StatTile label="Scrobbles" value={scrobbles} />}
      {reading && <StatTile label="Books read" value={reading.books} />}
      {reading && <StatTile label="Articles saved" value={reading.articles} />}
    </>
  )
}

/**
 * Keep root-relative links in the Markdown client-side. The body is mostly
 * pointers to other pages on this site, and a full reload on each one would be a
 * step back from the hand-written JSX this replaced. External links, anchors,
 * and mailto: fall through to a plain <a>.
 */
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
          {colophonPage.lead && <p className="lead">{colophonPage.lead}</p>}
        </header>

        <div className="post-source-bar">
          {/* The unfilled body, which is what content/colophon.md and the
              published .md both contain — the counts are substituted when the
              page renders, so {{photos}} is what was actually written. */}
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
