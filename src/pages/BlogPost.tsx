import { useRef, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSlug from 'rehype-slug'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router-dom'
import { ReadingProgress } from '../components/ReadingProgress'
import { Seo } from '../components/Seo'
import { imageUrl } from '../lib/images'
import { formatDate, formatReadingTime, type Post, type PostSummary } from '../lib/posts'
import { relatedPosts, tagPath } from '../lib/tags'
import { blogPostSchema, firstImagePath } from '../lib/structuredData'

/**
 * A heading that links to itself, so a section of a long post can be pointed at.
 *
 * The `id` comes from rehype-slug rather than from anything here: it dedupes
 * repeated headings (`#background`, `#background-1`) and derives the slug from
 * the heading's text after the markdown is parsed, which a `components` override
 * can't do without re-walking React children.
 *
 * The "#" is real, focusable text rather than a hover-only decoration, so it can
 * be reached by keyboard; the stylesheet keeps it out of the way until the
 * heading is hovered or the link is focused. It carries a class so
 * scripts/generate-rss.mjs can strip it back out — a feed reader has no use for
 * a link into a page it isn't showing.
 */
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
}

export async function getStaticPaths(): Promise<string[]> {
  const { loadPostSummaries } = await import('../lib/content.server')
  return (await loadPostSummaries()).map((post) => post.path.replace(/^\//, ''))
}

export async function loader({ params }: LoaderFunctionArgs): Promise<BlogPostData | null> {
  if (!import.meta.env.SSR && !import.meta.env.DEV) return null
  const source = import.meta.env.SSR
    ? await import('../lib/content.server')
    : await import('../lib/content.client')
  const posts = await source.loadPosts()
  const path = `/blog/${params.year}/${params.month}/${params.day}/${params.slug}`
  const index = posts.findIndex((post) => post.path === path)
  if (index === -1) throw new Response('Not found', { status: 404 })
  const summary = ({ body: _body, ...post }: Post): PostSummary => post
  return {
    post: posts[index],
    newer: posts[index - 1] ? summary(posts[index - 1]) : undefined,
    older: posts[index + 1] ? summary(posts[index + 1]) : undefined,
    related: relatedPosts(posts.map(summary), posts[index]),
    publicationUri: await source.loadPublicationUri(),
  }
}

export function Component() {
  const { post, newer, older, related, publicationUri } = useLoaderData() as BlogPostData
  const articleRef = useRef<HTMLElement>(null)
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
              {/* Only set for a substantive revision, so it's worth saying out
                  loud: the date above is when this was written, not when it last
                  said what it says now. It already reaches machines as JSON-LD
                  dateModified; this is the same fact for people. */}
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
      </article>
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
