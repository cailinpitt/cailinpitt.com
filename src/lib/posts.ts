import { parseFrontmatter } from './frontmatter'

export interface Post {
  /** Exact URL path, preserved from Squarespace, e.g. /blog/2023/3/3/paramore-this-is-why-2023 */
  path: string
  title: string
  /** ISO date string, e.g. 2023-03-03 */
  date: string
  /** Optional ISO date for a substantive revision. */
  updated?: string
  slug: string
  tags: string[]
  /** Optional cover/social image path */
  image?: string
  /** Optional short summary for listings + meta description */
  description?: string
  /** AT-URI of this post's site.standard.document record, if published (Phase 8). */
  atUri?: string
  /** Prose word count, computed at build time by countWords(). */
  words: number
  /** Markdown body */
  body: string
}

export type PostSummary = Omit<Post, 'body'>

export interface AtprotoData {
  did: string | null
  publication: string | null
  documents: Record<string, string>
}

/**
 * Prose words in a markdown body, for the reading-time estimate.
 *
 * Everything that isn't read aloud comes out first: code (which nobody reads at
 * prose speed), embedded HTML (a Spotify iframe is not 40 words), image syntax,
 * and link targets — though link *text* stays, since it's part of the sentence.
 * What survives is split on whitespace and filtered to tokens carrying at least
 * one letter or digit, which drops the punctuation left behind by the stripping.
 */
export function countWords(body: string): number {
  const prose = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_>~|=+-]/g, ' ')
  let words = 0
  for (const token of prose.split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) words += 1
  }
  return words
}

/** Words per minute. The usual figure for adult reading of general prose. */
const WPM = 200

/**
 * Below this, there is no estimate worth showing.
 *
 * Several posts are photo essays or embed lists with almost no prose — the
 * travel posts carry none at all. Rounding those up to "1 min read" states
 * something untrue about a page you can take in at a glance, so they get no
 * label instead. 100 words is half a minute at the rate above.
 */
const MIN_ESTIMATE_WORDS = 100

/** Whether a post has enough prose for a reading estimate to mean anything. */
export const hasReadingEstimate = (words: number): boolean => words >= MIN_ESTIMATE_WORDS

/** Minutes to read `words`, never less than one — "0 min read" helps nobody. */
export const readingMinutes = (words: number): number => Math.max(1, Math.round(words / WPM))

/** "5 min read" for a post with prose in it, null for one without. */
export const formatReadingTime = (words: number): string | null =>
  hasReadingEstimate(words) ? `${readingMinutes(words)} min read` : null

export function toPost(filePath: string, raw: string, atproto?: AtprotoData): Post {
  const { data, body } = parseFrontmatter(raw)
  const fallbackSlug = filePath.split('/').pop()!.replace(/\.md$/, '')
  const path = (data.path as string) ?? `/blog/${fallbackSlug}`
  return {
    path,
    title: (data.title as string) ?? fallbackSlug,
    date: (data.date as string) ?? '',
    updated: data.updated as string | undefined,
    slug: (data.slug as string) ?? fallbackSlug,
    tags: Array.isArray(data.tags) ? data.tags : [],
    image: data.image as string | undefined,
    description: data.description as string | undefined,
    atUri: atproto?.documents[path],
    // Counted here so it rides along on PostSummary, which drops the body: the
    // listings and the JSON-LD would otherwise have no way to get at it.
    words: countWords(body),
    body,
  }
}

export function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

/**
 * "March 3" — the same date with the year dropped, for lists that already carry
 * the year in a heading above the row (see /blog). Falls back to the full date
 * if the string won't parse, so a row never renders empty.
 */
export function formatMonthDay(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}

/** The calendar year of a post, from the ISO date. Empty when it has none. */
export const postYear = (iso: string): string => iso.slice(0, 4)

/**
 * Posts split into year sections, keeping the order they arrive in (newest
 * first). Posts with no parsable year land in an "Undated" group rather than
 * being dropped — the archive is old enough to have one, and the newest-first
 * sort puts an empty date last, so that group falls at the end on its own.
 */
export function postsByYear<T extends PostSummary>(posts: T[]): { year: string; posts: T[] }[] {
  const groups: { year: string; posts: T[] }[] = []
  for (const post of posts) {
    const year = /^\d{4}$/.test(postYear(post.date)) ? postYear(post.date) : 'Undated'
    const last = groups[groups.length - 1]
    if (last?.year === year) last.posts.push(post)
    else groups.push({ year, posts: [post] })
  }
  return groups
}
