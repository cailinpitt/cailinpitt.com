import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Link, useLoaderData } from 'react-router-dom'
import { PostHistory, useHistoryPanel } from '../components/PostHistory'
import { PostSource } from '../components/PostSource'
import { Seo } from '../components/Seo'
import type { PostHistory as PostHistoryData } from '../lib/history'
import { formatDate } from '../lib/posts'
import { pageSchema } from '../lib/structuredData'
import { usesPage } from '../lib/uses'

// A /uses page (uses.tech): the hardware, software, and services I actually
// reach for. Prose lives in content/uses.md — edit that, not this file.
//
// Like /now it leads with an "Updated" date read from git rather than a
// frontmatter field, because a gear list is only worth anything with one, and
// a hand-maintained date is exactly what goes stale first.

/** Where this page's own source is published — see scripts/generate-markdown.mjs. */
const SOURCE_FILE = '/uses.md'

interface UsesData {
  /** What git knows about content/uses.md; null outside a git checkout. */
  history: (PostHistoryData & { file: string }) | null
  /** Repo web URL, for linking commits. */
  repo: string | null
}

export async function loader(): Promise<UsesData | null> {
  if (!import.meta.env.SSR && !import.meta.env.DEV) return null
  // Imported here rather than at the top of the file so it lands in its own
  // chunk: the production client returns above without ever loading it.
  const { history, repo } = await import('virtual:post-history')
  return { history: history['/uses'] ?? null, repo }
}

/** Keep root-relative links client-side; matches /now and the colophon. */
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
  const { history, repo } = useLoaderData() as UsesData
  const [showSource, setShowSource] = useState(false)
  const panel = useHistoryPanel()

  const updated = history?.commits[0]?.date ?? null

  return (
    <>
      <Seo
        title={usesPage.title}
        description={usesPage.description}
        path="/uses"
        jsonLd={pageSchema({
          path: '/uses',
          title: usesPage.title,
          description: usesPage.description,
        })}
        markdownPath={SOURCE_FILE}
      />
      <article className="post">
        <header className="post-header">
          <h1>{usesPage.title}</h1>
          {usesPage.lead && <p className="lead">{usesPage.lead}</p>}
          {updated && (
            <p className="post-meta">
              <time dateTime={updated} className="post-date">
                Updated {formatDate(updated.slice(0, 10))}
              </time>
            </p>
          )}
        </header>

        <div className="post-source-bar">
          <PostSource
            body={usesPage.body}
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
          <pre className="post-source">{usesPage.body}</pre>
        ) : (
          <div className="post-body">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {usesPage.body}
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
