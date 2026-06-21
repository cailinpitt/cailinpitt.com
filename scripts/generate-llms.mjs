#!/usr/bin/env node
// Generate dist/llms.txt (curated index) and dist/llms-full.txt (full text) from
// content/blog/*.md. Runs after `npm run build` (part of the "postbuild" script).
// Format follows the llms.txt convention — see https://llmstxt.org.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BLOG = path.join(ROOT, 'content', 'blog')
const DIST = path.join(ROOT, 'dist')
const SITE = 'https://cailinpitt.com'
const SITE_NAME = 'Cailin Pitt'
const TAGLINE = 'Photography and writing by Cailin Pitt.'

// Mirrors src/lib/frontmatter.ts (same hand-rolled format the migration emits).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseValue(value) {
  if (value.startsWith('[')) {
    try {
      const arr = JSON.parse(value)
      if (Array.isArray(arr)) return arr.map(String)
    } catch {
      /* fall through */
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

function parseFrontmatter(raw) {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { data: {}, body: raw.trim() }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    data[line.slice(0, sep).trim()] = parseValue(line.slice(sep + 1).trim())
  }
  return { data, body: raw.slice(m[0].length).trim() }
}

// Strip HTML tags and image markdown so the full-text export reads as plain prose.
function cleanBody(body) {
  return body
    .replace(/<\/?[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('✗ No dist/ — run `npm run build` first.')
    process.exit(1)
  }

  const files = (await readdir(BLOG)).filter((f) => f.endsWith('.md'))
  const posts = []
  for (const f of files) {
    const raw = await readFile(path.join(BLOG, f), 'utf8')
    const { data, body } = parseFrontmatter(raw)
    const slug = f.replace(/\.md$/, '')
    posts.push({
      title: data.title ?? slug,
      date: data.date ?? '',
      path: data.path ?? `/blog/${slug}`,
      description: data.description ?? '',
      body,
    })
  }
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const index = [
    `# ${SITE_NAME}`,
    '',
    `> ${TAGLINE}`,
    '',
    '## Blog',
    '',
    ...posts.map((p) => `- [${p.title}](${SITE}${p.path})${p.description ? `: ${p.description}` : ''}`),
    '',
  ].join('\n')

  const full = [
    `# ${SITE_NAME}`,
    '',
    `> ${TAGLINE}`,
    '',
    ...posts.flatMap((p) => [
      '---',
      '',
      `# ${p.title}`,
      `${p.date}${p.date ? ' · ' : ''}${SITE}${p.path}`,
      '',
      cleanBody(p.body),
      '',
    ]),
  ].join('\n')

  await writeFile(path.join(DIST, 'llms.txt'), index, 'utf8')
  await writeFile(path.join(DIST, 'llms-full.txt'), full, 'utf8')
  console.log(`✓ llms.txt + llms-full.txt (${posts.length} posts)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
