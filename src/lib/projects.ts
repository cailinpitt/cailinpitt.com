import { parseFrontmatter } from './frontmatter'

export interface ProjectsPage {
  title: string
  /** Optional short summary for the meta description. */
  description?: string
  /** Markdown body */
  body: string
}

// Load the single Markdown source for the /projects page at build time. Using
// import.meta.glob (rather than a static import) keeps this resolving in both the
// Node SSG prerender and the browser build, matching how posts.ts loads content.
const rawModules = import.meta.glob('/content/projects.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const raw = Object.values(rawModules)[0] ?? ''
const { data, body } = parseFrontmatter(raw)

export const projectsPage: ProjectsPage = {
  title: (data.title as string) ?? 'Projects',
  description: data.description as string | undefined,
  body,
}
