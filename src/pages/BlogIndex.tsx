import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { formatDate, type PostSummary } from '../lib/posts'
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
    </>
  )
}
