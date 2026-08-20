import { formatNumber } from './datetime'
import { parseFrontmatter } from './frontmatter'

export interface ColophonPage {
  title: string
  /** One-line standfirst under the title. */
  lead?: string
  /** Optional short summary for the meta description. */
  description?: string
  /** Markdown body, still holding its {{placeholders}} — see fillTemplate. */
  body: string
}

// import.meta.glob (not a static import) so this resolves in both the SSG prerender and the browser build.
const rawModules = import.meta.glob('/content/colophon.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const raw = Object.values(rawModules)[0] ?? ''
const { data, body } = parseFrontmatter(raw)

export const colophonPage: ColophonPage = {
  title: (data.title as string) ?? 'Colophon',
  lead: data.lead as string | undefined,
  description: data.description as string | undefined,
  body,
}

export type TemplateValues = Record<string, string | number>

// Fill-in-the-blanks, not a template language: `{{photos}}` substitutes (number-formatted),
// `{{#located}}…{{/located}}` keeps its section only when that value is non-zero. Unknown
// placeholders are left as-is rather than blanked, so a typo is visible instead of silently
// deleting a sentence.
export function fillTemplate(body: string, values: TemplateValues): string {
  const present = (key: string) => {
    const value = values[key]
    return value !== undefined && value !== '' && value !== 0
  }

  return (
    body
      // Sections first: dropping one takes its placeholders with it.
      .replace(/\{\{#(\w+)\}\}\s*([\s\S]*?)\s*\{\{\/\1\}\}/g, (match, key: string, inner: string) =>
        key in values ? (present(key) ? inner : '') : match,
      )
      .replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
        const value = values[key]
        if (value === undefined) return match
        return typeof value === 'number' ? formatNumber(value) : value
      })
  )
}
