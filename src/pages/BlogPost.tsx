import { useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSlug from 'rehype-slug'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router-dom'
import { CommentsSection } from '../components/CommentsSection'
import { PostHistory, useHistoryPanel } from '../components/PostHistory'
import { PostShare } from '../components/PostShare'
import { PostSource } from '../components/PostSource'
import { ReadingProgress } from '../components/ReadingProgress'
import { Seo } from '../components/Seo'
import { imageUrl } from '../lib/images'
import type { PostHistory as PostHistoryData } from '../lib/history'
import { formatDate, formatReadingTime, type Post, type PostSummary } from '../lib/posts'
import { relatedPosts, tagPath } from '../lib/tags'
import { blogPostSchema, firstImagePath } from '../lib/structuredData'

// A heading that links to itself. `id` comes from rehype-slug (dedupes, derives
// the slug from parsed text — a `components` override can't do that without
// re-walking children). The "#" is real focusable text for keyboard reach, and
// carries a class so generate-rss.mjs can strip it from feed output.
const anchored = (Tag: 'h2' | 'h3' | 'h4') =>
  function Heading({ children, id }: { node?: unknown; children?: ReactNode; id?: string }) {
    return (
      <Tag id={id}>
        {children}
        {id && (
          <a className="heading-anchor" href={`#${id}`} aria-label="Link to this section">
            #
          </a>
        )}
      </Tag>
    )
  }

const markdownComponents = {
  // Rewrite root-relative /images/... sources in post bodies to their R2 URLs.
  img: ({ node: _node, ...props }: { node?: unknown; src?: string }) => (
    <img {...props} src={imageUrl(props.src)} />
  ),
  // Same rewrite for links that point straight at an image (e.g. a thumbnail
  // grid linking to the full-size rendition).
  a: ({ node: _node, ...props }: { node?: unknown; href?: string }) =>
    props.href?.startsWith('/images/') ? (
      <a {...props} href={imageUrl(props.href)} />
    ) : (
      <a {...props} />
    ),
  h2: anchored('h2'),
  h3: anchored('h3'),
  h4: anchored('h4'),
}

interface BlogPostData {
  post: Post
  older?: PostSummary
  newer?: PostSummary
  /** Posts sharing tags with this one; empty when it has none. */
  related: PostSummary[]
  publicationUri: string | null
  /** What git knows about this post's file; null outside a git checkout. */
  history: (PostHistoryData & { file: string }) | null
  /** Repo web URL, for linking commits. */
  repo: string | null
}

export async function getStaticPaths(): Promise<string[]> {
  const { loadPostSummaries } = await import('../lib/content.server')
  return (await loadPostSummaries()).map((post) => post.path.replace(/^\//, ''))
}

// publicationUri lives apart from loadPosts (content.server / content.client vs.
// blogPosts.client), so the two sources are fetched independently rather than through
// one shared module reference.
async function loadPostsAndPublicationUri(): Promise<[Post[], string | null]> {
  if (import.meta.env.SSR) {
    const { loadPosts, loadPublicationUri } = await import('../lib/content.server')
    return Promise.all([loadPosts(), loadPublicationUri()])
  }
  const { loadPosts } = await import('../lib/blogPosts.client')
  const { loadPublicationUri } = await import('../lib/content.client')
  return [loadPosts(), loadPublicationUri()]
}

export async function loader({ params }: LoaderFunctionArgs): Promise<BlogPostData | null> {
  if (!import.meta.env.SSR && !import.meta.env.DEV) return null
  const [posts, publicationUri] = await loadPostsAndPublicationUri()
  const path = `/blog/${params.year}/${params.month}/${params.day}/${params.slug}`
  const index = posts.findIndex((post) => post.path === path)
  if (index === -1) throw new Response('Not found', { status: 404 })
  const summary = ({ body: _body, ...post }: Post): PostSummary => post
  // Dynamic import so this lands in its own chunk: the production client
  // returns above without loading it, and full post history shouldn't bloat
  // the page's own bundle.
  const { history, repo } = await import('virtual:post-history')
  return {
    post: posts[index],
    newer: posts[index - 1] ? summary(posts[index - 1]) : undefined,
    older: posts[index + 1] ? summary(posts[index + 1]) : undefined,
    related: relatedPosts(posts.map(summary), posts[index]),
    publicationUri,
    history: history[path] ?? null,
    repo,
  }
}

export function Component() {
  const { post, newer, older, related, publicationUri, history, repo } =
    useLoaderData() as BlogPostData
  const articleRef = useRef<HTMLElement>(null)
  const [showSource, setShowSource] = useState(false)
  const panel = useHistoryPanel()
  // Fall back to the first image in the body so posts without an explicit `image:`
  // frontmatter field still get a photo behind their card (matches the JSON-LD cover).
  const cover = post.image ?? firstImagePath(post.body)
  const readingTime = formatReadingTime(post.words)
  return (
    <>
      <Seo
        title={post.title}
        description={post.description}
        path={post.path}
        card={{
          kicker: post.tags[0] ?? 'Writing',
          meta: [formatDate(post.date), readingTime].filter(Boolean).join(' · '),
          photo: imageUrl(cover),
        }}
        type="article"
        jsonLd={blogPostSchema(post)}
        publicationUri={publicationUri}
        documentUri={post.atUri}
        markdownPath={`${post.path}.md`}
      />
      <ReadingProgress targetRef={articleRef} />
      <article className="post" ref={articleRef}>
        <header className="post-header">
          <h1>{post.title}</h1>
          {(post.date || readingTime || post.updated) && (
            <p className="post-meta">
              {post.date && (
                <time dateTime={post.date} className="post-date">
                  {formatDate(post.date)}
                </time>
              )}
              {readingTime && <span className="post-reading-time">{readingTime}</span>}
              {/* Only set for a substantive revision — same fact as JSON-LD
                  dateModified, surfaced here for people. */}
              {post.updated && (
                <time dateTime={post.updated} className="post-updated">
                  Updated {formatDate(post.updated)}
                </time>
              )}
            </p>
          )}
          {post.tags.length > 0 && (
            <ul className="tag-list" aria-label="Tags">
              {post.tags.map((tag) => (
                <li key={tag}>
                  <Link to={tagPath(tag)}>{tag}</Link>
                </li>
              ))}
            </ul>
          )}
        </header>
        <div className="post-source-bar">
          <PostShare path={post.path} title={post.title} />
          <a href={`mailto:hello@cailinpitt.com?subject=${encodeURIComponent(`Re: "${post.title}"`)}`}>
            Reply by email
          </a>
          <PostSource
            body={post.body}
            file={`${post.path}.md`}
            open={showSource}
            onToggle={setShowSource}
          />
          {/* Plain hash link (works pre-hydration, shareable) that also opens
              the panel, so it lands on the list, not a collapsed line. */}
          {history && (
            <a href="#history" onClick={panel.openFromLink}>
              History
            </a>
          )}
        </div>
        {showSource ? (
          <pre className="post-source">{post.body}</pre>
        ) : (
          <div className="post-body">
            <Markdown
              remarkPlugins={[remarkGfm]}
              // rehypeRaw first: it turns embedded HTML into real nodes, which is
              // what lets rehypeSlug give a hand-written <h2> an id too.
              rehypePlugins={[rehypeRaw, rehypeSlug]}
              components={markdownComponents}
            >
              {post.body}
            </Markdown>
          </div>
        )}
      </article>
      {/* Outside <article>: this is a record about the post, so the reading
          progress bar (measured on the article) completes at end of prose. */}
      {history && (
        <PostHistory history={history} repo={repo} open={panel.open} onToggle={panel.setOpen} />
      )}
      {related.length > 0 && (
        <aside className="related-posts" aria-labelledby="related-heading">
          <h2 id="related-heading" className="eyebrow">
            🔗 Related posts
          </h2>
          <ul className="post-list">
            {related.map((p) => (
              <li key={p.path}>
                <time dateTime={p.date}>{formatDate(p.date)}</time>
                <Link to={p.path}>{p.title}</Link>
              </li>
            ))}
          </ul>
        </aside>
      )}

      {(newer || older) && (
        <nav className="post-navigation" aria-label="More posts">
          {newer ? (
            <Link to={newer.path} rel="next">
              <span>Newer post</span>
              {newer.title}
            </Link>
          ) : (
            <span />
          )}
          {older && (
            <Link to={older.path} rel="prev">
              <span>Older post</span>
              {older.title}
            </Link>
          )}
        </nav>
      )}

      <CommentsSection postPath={post.path} />
    </>
  )
}

export function ErrorBoundary() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        That post does not exist. <Link to="/blog">Browse the blog</Link>.
      </p>
    </>
  )
}
