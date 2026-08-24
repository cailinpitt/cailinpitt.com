import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { formatDate, type PostSummary } from '../lib/posts'
import { collectTags, postsWithTag } from '../lib/tags'
import { blogTagSchema } from '../lib/structuredData'

interface BlogTagData {
  slug: string
  label: string
  posts: PostSummary[]
}

// One prerendered page per tag actually in use, so every chip on a post resolves
// to a real HTML file rather than a client-only route.
export async function getStaticPaths(): Promise<string[]> {
  const { loadPostSummaries } = await import('../lib/content.server')
  return collectTags(await loadPostSummaries()).map((tag) => `blog/tag/${tag.slug}`)
}

export async function loader({ params }: LoaderFunctionArgs): Promise<BlogTagData | null> {
  if (!import.meta.env.SSR && !import.meta.env.DEV) return null
  const source = import.meta.env.SSR
    ? await import('../lib/content.server')
    : await import('../lib/blogPosts.client')
  const all = await source.loadPostSummaries()
  const slug = params.tag ?? ''
  // Resolve through collectTags so the heading shows the tag's real spelling
  // ("Year in Review"), not the slug from the URL.
  const tag = collectTags(all).find((item) => item.slug === slug)
  if (!tag) throw new Response('Not found', { status: 404 })
  return { slug: tag.slug, label: tag.label, posts: postsWithTag(all, tag.slug) }
}

export function Component() {
  const { slug, label, posts } = useLoaderData() as BlogTagData
  const path = `/blog/tag/${slug}`
  const description = `Posts by Cailin Pitt tagged “${label}”.`

  return (
    <>
      <Seo
        title={`Tagged “${label}”`}
        description={description}
        path={path}
        jsonLd={blogTagSchema(label, path, posts)}
      />
      <section className="post">
        <header className="post-header">
          <p className="tag-eyebrow">
            <Link to="/blog">← All posts</Link>
          </p>
          <h1>{label}</h1>
          <p className="tag-count">
            {posts.length} {posts.length === 1 ? 'post' : 'posts'}
          </p>
        </header>
        <ul className="post-list">
          {posts.map((post) => (
            <li key={post.path}>
              <time dateTime={post.date}>{formatDate(post.date)}</time>
              <Link to={post.path}>{post.title}</Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

export function ErrorBoundary() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        Nothing is tagged that. <Link to="/blog">Browse the blog</Link>.
      </p>
    </>
  )
}
