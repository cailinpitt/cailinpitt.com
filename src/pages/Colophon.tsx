import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { StatTile } from '../components/ListeningBits'
import { colophonPage, fillTemplate } from '../lib/colophon'
import { fetchNow } from '../lib/listening'
import { fetchReading } from '../lib/reading'
import { pageSchema } from '../lib/structuredData'

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
  galleries: number
  located: number
}

export async function loader(): Promise<ColophonData | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    const { loadGalleries, loadPostSummaries } = await import('../lib/content.client')
    return summarize(loadPostSummaries(), loadGalleries())
  }
  const { loadGalleries, loadPostSummaries } = await import('../lib/content.server')
  const [posts, galleries] = await Promise.all([loadPostSummaries(), loadGalleries()])
  return summarize(posts, galleries)
}

function summarize(
  posts: { words: number }[],
  galleries: { canonicalPath?: string; images: { exif?: { place?: number[] } }[] }[],
): ColophonData {
  // Alias galleries (/past-work → /2022) point at another gallery's images, so
  // counting them would count those photos twice.
  const real = galleries.filter((gallery) => !gallery.canonicalPath)
  const images = real.flatMap((gallery) => gallery.images)
  return {
    posts: posts.length,
    words: posts.reduce((total, post) => total + post.words, 0),
    photos: images.length,
    galleries: real.length,
    located: images.filter((image) => image.exif?.place?.length === 2).length,
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
  const body = useMemo(() => fillTemplate(colophonPage.body, { ...data }), [data])

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
      />
      <article className="post">
        <header className="post-header">
          <h1>{colophonPage.title}</h1>
          {colophonPage.lead && <p className="lead">{colophonPage.lead}</p>}
        </header>

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
      </article>
    </>
  )
}
