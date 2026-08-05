import { parseFrontmatter } from './frontmatter'

export interface AboutPage {
  title: string
  /** One-line standfirst under the title. */
  lead?: string
  /** Optional short summary for the meta description. */
  description?: string
  /** Markdown body */
  body: string
}

// Same loading shape as now.ts, uses.ts, colophon.ts, and projects.ts:
// import.meta.glob rather than a static import, so it resolves in both the SSG
// prerender and the browser build.
const rawModules = import.meta.glob('/content/about.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const raw = Object.values(rawModules)[0] ?? ''
const { data, body } = parseFrontmatter(raw)

export const aboutPage: AboutPage = {
  title: (data.title as string) ?? 'About',
  lead: data.lead as string | undefined,
  description: data.description as string | undefined,
  body,
}
