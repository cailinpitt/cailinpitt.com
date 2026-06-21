import { parseFrontmatter } from './frontmatter'

export interface Post {
  /** Exact URL path, preserved from Squarespace, e.g. /blog/2023/3/3/paramore-this-is-why-2023 */
  path: string
  title: string
  /** ISO date string, e.g. 2023-03-03 */
  date: string
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

// standard.site (AT Protocol) record map, populated by `npm run publish:atproto`.
// We commit an empty default so this file always exists, letting import.meta.glob
// resolve in both Node (SSG prerender) and the browser build.
interface AtprotoData {
  did: string | null
  publication: string | null
  documents: Record<string, string>
}
const atprotoModules = import.meta.glob('/content/atproto.json', { eager: true }) as Record<
  string,
  { default: AtprotoData }
>
const atproto: AtprotoData = Object.values(atprotoModules)[0]?.default ?? {
  did: null,
  publication: null,
  documents: {},
}

/** AT-URI of the site.standard.publication record, or null until published. */
export const atprotoPublicationUri: string | null = atproto.publication

// Eagerly load every Markdown file in /content/blog as a raw string at build time.
// import.meta.glob runs during both the SSG prerender and the client build, so the
// post list is identical in Node and the browser.
const rawPosts = import.meta.glob('/content/blog/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function toPost(filePath: string, raw: string): Post {
  const { data, body } = parseFrontmatter(raw)
  const fallbackSlug = filePath.split('/').pop()!.replace(/\.md$/, '')
  const path = (data.path as string) ?? `/blog/${fallbackSlug}`
  return {
    path,
    title: (data.title as string) ?? fallbackSlug,
    date: (data.date as string) ?? '',
    slug: (data.slug as string) ?? fallbackSlug,
    tags: Array.isArray(data.tags) ? data.tags : [],
    image: data.image as string | undefined,
    description: data.description as string | undefined,
    atUri: atproto.documents[path],
    body,
  }
}

export const posts: Post[] = Object.entries(rawPosts)
  .map(([file, raw]) => toPost(file, raw))
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

export function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}
