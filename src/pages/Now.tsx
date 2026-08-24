import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Link, useLoaderData } from 'react-router-dom'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { PhotoStrip } from '../components/PhotoStrip'
import { PostHistory, useHistoryPanel } from '../components/PostHistory'
import { PostSource } from '../components/PostSource'
import { ReadingBar } from '../components/ReadingBar'
import { WatchingBar } from '../components/WatchingBar'
import { ConcertBar } from '../components/ConcertBar'
import { MovingBar } from '../components/MovingBar'
import { Seo } from '../components/Seo'
import type { PostHistory as PostHistoryData } from '../lib/history'
import { nowPage } from '../lib/now'
import { toPreviews, type PhotoPreview } from '../lib/photos'
import { formatDate } from '../lib/posts'
import type { Concert } from '../lib/concerts'
import { pageSchema } from '../lib/structuredData'

// A /now page (nownownow.org). Prose lives in content/now.md — edit that, not
// this file; this file only adds what Markdown can't carry: when it was last
// true, and what's happening right now.

/** Where this page's own source is published — see scripts/generate-markdown.mjs. */
const SOURCE_FILE = '/now.md'

/** How many photographs the strip shows. Three, to sit on one row beside the bars. */
const RECENT_PHOTOS = 3

interface NowData {
  photos: PhotoPreview[]
  /** What git knows about content/now.md; null outside a git checkout. */
  history: (PostHistoryData & { file: string }) | null
  /** Repo web URL, for linking commits. */
  repo: string | null
  lastConcert: Concert | null
}

export async function loader(): Promise<NowData | null> {
  if (!import.meta.env.SSR && !import.meta.env.DEV) return null
  const { loadPhotos, loadConcerts } = import.meta.env.SSR
    ? await import('../lib/content.server')
    : await import('../lib/content.client')
  // Imported here rather than at the top of the file so it lands in its own
  // chunk: the production client returns above without ever loading it.
  const { history, repo } = await import('virtual:post-history')
  const [photos, concerts] = await Promise.all([loadPhotos(), loadConcerts()])
  return {
    photos: toPreviews(photos, RECENT_PHOTOS),
    history: history['/now'] ?? null,
    repo,
    lastConcert: concerts[0] ?? null,
  }
}

/** Keep root-relative links client-side; matches the colophon. */
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
  const { photos, history, repo, lastConcert } = useLoaderData() as NowData
  const [showSource, setShowSource] = useState(false)
  const panel = useHistoryPanel()

  // From git, not a frontmatter field easy to forget to bump — the page's
  // whole claim is "this was true recently," so it belongs up top.
  const updated = history?.commits[0]?.date ?? null

  return (
    <>
      <Seo
        title={nowPage.title}
        description={nowPage.description}
        path="/now"
        jsonLd={pageSchema({
          path: '/now',
          title: nowPage.title,
          description: nowPage.description,
        })}
        markdownPath={SOURCE_FILE}
      />
      <article className="post now-page">
        <header className="post-header">
          <h1>{nowPage.title}</h1>
          {nowPage.lead && <p>{nowPage.lead}</p>}
          {updated && (
            <p className="post-meta">
              <time dateTime={updated} className="post-date">
                Updated {formatDate(updated.slice(0, 10))}
              </time>
            </p>
          )}
        </header>

        {/* Above the prose since it's true as of now, not the date above. Plain
            div, not a labelled <section>: bars render nothing until their fetch
            lands, and a section would announce an empty region meanwhile. */}
        <div className="now-live">
          <NowPlayingBar />
          <ReadingBar showLogLinks={false} />
          <WatchingBar />
          <ConcertBar concert={lastConcert} />
          <MovingBar />
          {/* Prerendered from the build, unlike the bars above (Worker-fetched). */}
          <PhotoStrip photos={photos} />
        </div>

        <div className="post-source-bar">
          <PostSource
            body={nowPage.body}
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
          <pre className="post-source">{nowPage.body}</pre>
        ) : (
          <div className="post-body">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {nowPage.body}
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
