import type { PostSummary } from './posts'

// Tags come from post frontmatter as free text ("Year in Review", "agile"), so everything
// here keys off a slugified form — the URL, and what stops a casing difference splitting one tag in two.

/** URL-safe form of a tag, e.g. "Year in Review" → "year-in-review". */
export function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const tagPath = (tag: string): string => `/blog/tag/${tagSlug(tag)}`

export interface TagSummary {
  slug: string
  label: string
  count: number
}

// Most-used first, then alphabetical. Label is the spelling from the first post using it —
// posts arrive newest-first, so the most recent spelling wins.
export function collectTags(posts: PostSummary[]): TagSummary[] {
  const byTag = new Map<string, TagSummary>()
  for (const post of posts) {
    for (const tag of post.tags) {
      const slug = tagSlug(tag)
      if (!slug) continue
      const existing = byTag.get(slug)
      if (existing) existing.count += 1
      else byTag.set(slug, { slug, label: tag, count: 1 })
    }
  }
  return [...byTag.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** Posts carrying `slug`, keeping the order they were given in. */
export function postsWithTag<T extends PostSummary>(posts: T[], slug: string): T[] {
  return posts.filter((post) => post.tags.some((tag) => tagSlug(tag) === slug))
}

// Ranked by shared tag count; ties break toward the newer post via `posts`'s own order. A
// post with no tags gets nothing back rather than an arbitrary three.
export function relatedPosts<T extends PostSummary>(posts: T[], post: PostSummary, limit = 3): T[] {
  const own = new Set(post.tags.map(tagSlug).filter(Boolean))
  if (!own.size) return []

  return posts
    .filter((candidate) => candidate.path !== post.path)
    .map((candidate) => ({
      post: candidate,
      shared: candidate.tags.reduce((n, tag) => n + (own.has(tagSlug(tag)) ? 1 : 0), 0),
    }))
    .filter((scored) => scored.shared > 0)
    // Stable within a score, so the incoming (newest-first) order is the tiebreak.
    .sort((a, b) => b.shared - a.shared)
    .slice(0, limit)
    .map((scored) => scored.post)
}
