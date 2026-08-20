import { parseFrontmatter } from './frontmatter'

export interface NowPage {
  title: string
  /** One-line standfirst under the title. */
  lead?: string
  /** Optional short summary for the meta description. */
  description?: string
  /** Markdown body */
  body: string
}

// import.meta.glob (not a static import) so this resolves in both the SSG prerender and the browser.
const rawModules = import.meta.glob('/content/now.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const raw = Object.values(rawModules)[0] ?? ''
const { data, body } = parseFrontmatter(raw)

export const nowPage: NowPage = {
  title: (data.title as string) ?? 'Now',
  lead: data.lead as string | undefined,
  description: data.description as string | undefined,
  body,
}
