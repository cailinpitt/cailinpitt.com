import { parseFrontmatter } from './frontmatter'

export interface ProjectsPage {
  title: string
  /** Optional short summary for the meta description. */
  description?: string
  /** Markdown body */
  body: string
}

// import.meta.glob (not a static import) so this resolves in both the SSG prerender and the browser build.
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
