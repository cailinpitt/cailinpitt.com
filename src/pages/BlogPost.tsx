import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { imageUrl } from '../lib/images'
import { formatDate, type Post, type PostSummary } from '../lib/posts'
import { blogPostSchema, firstImagePath } from '../lib/structuredData'

// Rewrite root-relative /images/... sources in post bodies to their R2 URLs.
const markdownComponents = {
  img: ({ node: _node, ...props }: { node?: unknown; src?: string }) => (
    <img {...props} src={imageUrl(props.src)} />
  ),
}

interface BlogPostData {
  post: Post
  older?: PostSummary
  newer?: PostSummary
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
    publicationUri: await source.loadPublicationUri(),
  }
}

export function Component() {
  const { post, newer, older, publicationUri } = useLoaderData() as BlogPostData
  // Fall back to the first image in the body so posts without an explicit `image:`
  // frontmatter field still get a social-card thumbnail (matches the JSON-LD cover).
  const cover = post.image ?? firstImagePath(post.body)
  return (
    <>
      <Seo
        title={post.title}
        description={post.description}
        path={post.path}
        image={imageUrl(cover)}
        type="article"
        jsonLd={blogPostSchema(post)}
        publicationUri={publicationUri}
        documentUri={post.atUri}
      />
      <article className="post">
        <header className="post-header">
          <h1>{post.title}</h1>
          {post.date && (
            <time dateTime={post.date} className="post-date">
              {formatDate(post.date)}
            </time>
          )}
        </header>
        <div className="post-body">
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={markdownComponents}
          >
            {post.body}
          </Markdown>
        </div>
      </article>
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
