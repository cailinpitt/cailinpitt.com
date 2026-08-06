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
import { Seo } from '../components/Seo'
import type { PostHistory as PostHistoryData } from '../lib/history'
import { nowPage } from '../lib/now'
import { toPreviews, type PhotoPreview } from '../lib/photos'
import { formatDate } from '../lib/posts'
import { pageSchema } from '../lib/structuredData'

// A /now page (nownownow.org): what has my attention at the moment, which is a
// different question from what the blog archive or /projects answers.
//
// The prose is content/now.md — edit that, not this file. Everything else here
// is the two things a page like this needs that a Markdown file can't carry:
// when it was last true, and what is happening right now.

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
}

export async function loader(): Promise<NowData | null> {
  if (!import.meta.env.SSR && !import.meta.env.DEV) return null
  const { loadPhotos } = import.meta.env.SSR
    ? await import('../lib/content.server')
    : await import('../lib/content.client')
  // Imported here rather than at the top of the file so it lands in its own
  // chunk: the production client returns above without ever loading it.
  const { history, repo } = await import('virtual:post-history')
  return {
    photos: toPreviews(await loadPhotos(), RECENT_PHOTOS),
    history: history['/now'] ?? null,
    repo,
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
  const { photos, history, repo } = useLoaderData() as NowData
  const [showSource, setShowSource] = useState(false)
  const panel = useHistoryPanel()

  /**
   * The date of the last commit to touch this file.
   *
   * The whole claim a /now page makes is "this was true recently", so the date
   * belongs at the top rather than in the provenance line at the foot — and it
   * comes from git rather than a frontmatter field, which is the sort of thing
   * you forget to bump in the edit where it matters most.
   */
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
          {nowPage.lead && <p className="lead">{nowPage.lead}</p>}
          {updated && (
            <p className="post-meta">
              <time dateTime={updated} className="post-date">
                Updated {formatDate(updated.slice(0, 10))}
              </time>
            </p>
          )}
        </header>

        {/* Live, and deliberately above the prose: the rest of the page is true
            as of the date above, this is true as of now. Both render nothing
            until their fetch lands, so the page reads fine without them — which
            is also why this is a plain div. A labelled <section> would announce
            an empty region on every prerendered load. */}
        <div className="now-live">
          <NowPlayingBar />
          <ReadingBar />
          <WatchingBar />
          {/* The newest frames, under the bars. Prerendered, unlike the two
              above it — these come from the build, not a Worker. */}
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
