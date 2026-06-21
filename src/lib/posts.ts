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
  /** Markdown body */
  body: string
}

export type PostSummary = Omit<Post, 'body'>

export interface AtprotoData {
  did: string | null
  publication: string | null
  documents: Record<string, string>
}

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
    body,
  }
}

export function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}
