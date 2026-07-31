import type { PostSummary } from './posts'

// Tags come from post frontmatter as free text ("Year in Review", "agile"), so
// everything here keys off a slugified form: it's what goes in the URL, and it
// keeps a casing difference between two posts from splitting one tag in two.

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

/**
 * Every tag used across `posts`, most-used first and then alphabetical. The
 * label shown is the spelling from the first post in the list that uses it —
 * posts arrive newest-first, so the most recent spelling wins.
 */
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
