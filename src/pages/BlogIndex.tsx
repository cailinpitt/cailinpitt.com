import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { formatDate, type PostSummary } from '../lib/posts'
import { collectTags } from '../lib/tags'
import { blogIndexSchema } from '../lib/structuredData'

export async function loader(): Promise<PostSummary[] | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    return (await import('../lib/content.client')).loadPostSummaries()
  }
  const { loadPostSummaries } = await import('../lib/content.server')
  return loadPostSummaries()
}

export function Component() {
  const posts = useLoaderData() as PostSummary[]
  const tags = collectTags(posts)
  return (
    <>
      <Seo
        title="Blog"
        description="Writing by Cailin Pitt."
        path="/blog"
        jsonLd={blogIndexSchema(posts)}
      />
      <section className="post">
        <header className="post-header">
          <h1>Blog</h1>
        </header>
        <ul className="post-list">
          {posts.map((p) => (
            <li key={p.path}>
              <time dateTime={p.date}>{formatDate(p.date)}</time>
              <Link to={p.path}>{p.title}</Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Below the list rather than above it: the posts are what someone came
          for, and 40-odd chips would push them off the first screen. */}
      {tags.length > 0 && (
        <section className="post tag-index" aria-labelledby="tags-heading">
          <h2 id="tags-heading" className="eyebrow">
            🏷️ Browse by tag
          </h2>
          <ul className="tag-list is-cloud">
            {tags.map((tag) => (
              <li key={tag.slug}>
                <Link to={`/blog/tag/${tag.slug}`}>
                  {tag.label}
                  <span className="tag-count-badge">{tag.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
