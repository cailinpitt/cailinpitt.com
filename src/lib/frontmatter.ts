// Minimal, dependency-free frontmatter parser.
//
// We control the exact format the migration script emits (see scripts/migrate-posts.mjs),
// so we don't need a full YAML parser (and we avoid pulling gray-matter / Buffer into the
// browser bundle). Supported value forms per line:
//   key: plain text
//   key: "quoted text"
//   key: ["json", "array"]

export interface Frontmatter {
  [key: string]: string | string[] | undefined
}

export interface ParsedDoc {
  data: Frontmatter
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseFrontmatter(raw: string): ParsedDoc {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return { data: {}, body: raw.trim() }

  const data: Frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    const rawValue = line.slice(sep + 1).trim()
    data[key] = parseValue(rawValue)
  }

  const body = raw.slice(match[0].length).trim()
  return { data, body }
}

function parseValue(value: string): string | string[] {
  if (value.startsWith('[')) {
    try {
      const arr = JSON.parse(value)
      if (Array.isArray(arr)) return arr.map(String)
    } catch {
      /* fall through to string handling */
    }
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
