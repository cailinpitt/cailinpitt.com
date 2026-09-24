import type { PostSummary } from './posts'

// Links between posts, read from the markdown at build time. A link can be written root-relative
// or absolute (with or without www), and a path's month/day may or may not be zero-padded, so
// everything is compared by postKey().

const POST_URL =
  /^(?:https?:\/\/(?:www\.)?cailinpitt\.com)?\/blog\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/([^/?#.\s]+)/i

/** A post path with padding and any origin, query, hash or `.md` dropped; null if not a post URL. */
export function postKey(url: string): string | null {
  const match = url.trim().match(POST_URL)
  if (!match) return null
  const [, year, month, day, slug] = match
  return `/blog/${year}/${Number(month)}/${Number(day)}/${slug.toLowerCase()}`
}

/** Keys of every post URL a markdown body links to, in order of first appearance. */
export function linkedKeys(body: string): string[] {
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const urls = [
    ...text.matchAll(/\]\(\s*<?([^)\s>]+)/g),
    ...text.matchAll(/href\s*=\s*["']([^"']+)["']/gi),
    ...text.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?\s*$/gm),
    ...text.matchAll(/<(https?:\/\/[^>\s]+)>/g),
  ]
    .sort((a, b) => a.index - b.index)
    .map((match) => match[1])
  const keys = urls.map(postKey).filter((key): key is string => key !== null)
  return [...new Set(keys)]
}

export interface PostLinks<T> {
  /** Posts this one links to. */
  outgoing: T[]
  /** Posts that link to this one, newest first. */
  incoming: T[]
}

// Links to posts that don't exist are dropped, as are a post's links to itself.
export function postLinks<T extends PostSummary>(
  posts: (T & { body: string })[],
  post: PostSummary,
): PostLinks<T> {
  const byKey = new Map(posts.map((p) => [postKey(p.path), p]))
  const self = postKey(post.path)
  const resolve = (body: string) =>
    linkedKeys(body)
      .filter((key) => key !== self)
      .map((key) => byKey.get(key))
      .filter((p): p is T & { body: string } => p !== undefined)

  const own = posts.find((p) => p.path === post.path)
  return {
    outgoing: own ? resolve(own.body) : [],
    incoming: posts.filter((p) => p.path !== post.path && linkedKeys(p.body).includes(self!)),
  }
}
