import { useId, useMemo, useState } from 'react'
import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { formatMonthDay, formatReadingTime, postsByYear, type PostSummary } from '../lib/posts'
import { collectTags } from '../lib/tags'
import { blogIndexSchema } from '../lib/structuredData'

export async function loader(): Promise<PostSummary[] | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    return (await import('../lib/blogPosts.client')).loadPostSummaries()
  }
  const { loadPostSummaries } = await import('../lib/content.server')
  return loadPostSummaries()
}

// Matched fields: title, summary, tags, and the date in both ISO and written
// form — so "2019", "march", and "music" all find something.
const haystack = (post: PostSummary): string =>
  [post.title, post.description ?? '', post.tags.join(' '), post.date, formatMonthDay(post.date)]
    .join(' ')
    .toLowerCase()

// Every term must appear somewhere, any order — "music 2019" narrows rather
// than widening like an OR would. Substring, not prefix, so "york" finds
// "New York".
function filterPosts(posts: PostSummary[], index: Map<string, string>, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return posts
  return posts.filter((post) => {
    const text = index.get(post.path) ?? ''
    return terms.every((term) => text.includes(term))
  })
}

export function Component() {
  const posts = useLoaderData() as PostSummary[]
  const tags = collectTags(posts)
  const [query, setQuery] = useState('')
  const inputId = useId()

  // ~35 posts, so filtering is a substring scan over a map built once — no
  // index, no dependency, nothing to fetch. Also works with JS off: the input
  // goes inert and the full list is already in the prerendered HTML.
  const index = useMemo(() => new Map(posts.map((post) => [post.path, haystack(post)])), [posts])
  const matches = useMemo(() => filterPosts(posts, index, query), [posts, index, query])
  const years = useMemo(() => postsByYear(matches), [matches])
  const filtering = query.trim().length > 0

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
          <div className="post-filter">
            <label className="visually-hidden" htmlFor={inputId}>
              Filter posts by title, tag, or year
            </label>
            <input
              id={inputId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title, tag, or year…"
              autoComplete="off"
              spellCheck={false}
            />
            {/* Announced on change, so an emptied list says so to a screen
                reader rather than silently removing everything. */}
            <p className="post-count" role="status">
              {filtering ? `${matches.length} of ${posts.length} posts` : `${posts.length} posts`}
            </p>
          </div>
          {/* Plain <a>: /feed.xml is a static file in dist/, not a route. */}
          <p className="post-subscribe">
            <a href="/feed.xml" type="application/rss+xml">
              Subscribe via RSS
            </a>
          </p>
        </header>

        {matches.length === 0 ? (
          <p className="post-empty">
            Nothing matches “{query.trim()}”.{' '}
            <button type="button" onClick={() => setQuery('')}>
              Clear the filter
            </button>
            .
          </p>
        ) : (
          years.map((group) => (
            <section className="post-year" key={group.year} aria-labelledby={`year-${group.year}`}>
              <h2 className="year-heading" id={`year-${group.year}`}>
                {group.year}
              </h2>
              <ul className="post-list">
                {group.posts.map((p) => (
                  <li key={p.path}>
                    <p className="post-list-meta">
                      {/* Year is in the heading above, so the row shows only
                          month/day — dateTime stays the full date. */}
                      <time dateTime={p.date}>{formatMonthDay(p.date)}</time>
                      {/* Absent for posts with almost no prose — the travel
                          posts are photographs, and "1 min read" would
                          misdescribe them. */}
                      {formatReadingTime(p.words) && (
                        <span className="post-list-time">{formatReadingTime(p.words)}</span>
                      )}
                    </p>
                    <Link to={p.path}>{p.title}</Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </section>

      {/* Below the list: the posts are what someone came for, and 40-odd
          chips would push them off the first screen. */}
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
