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

// Same loading shape as projects.ts: import.meta.glob (rather than a static
// import) keeps this resolving in both the Node SSG prerender and the browser
// build.
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

/**
 * The counters the prose quotes, substituted into the Markdown before it's
 * rendered.
 *
 * Two forms, both deliberately tiny — this is a fill-in-the-blanks step, not a
 * template language, and anything more would be better off back in JSX:
 *
 *   {{photos}}                  the value, thousands-separated if it's a number
 *   {{#located}}…{{/located}}   kept only when that value is non-zero
 *
 * The section form exists because a count can legitimately be zero, and "0 of
 * them carry a location" is a sentence that shouldn't be published. A repo whose
 * photos carry no EXIF just doesn't get that paragraph.
 *
 * An unknown placeholder is left in the text rather than blanked, so a typo
 * shows up as `{{photoss}}` the first time the page is previewed instead of
 * silently deleting half a sentence.
 */
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
