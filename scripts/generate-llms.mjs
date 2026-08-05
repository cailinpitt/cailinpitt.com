#!/usr/bin/env node
// Generate dist/llms.txt (curated index) and dist/llms-full.txt (full text) from
// content/now.md, content/projects.md, content/uses.md, content/colophon.md, and
// content/blog/*.md. Runs after `npm run build` (part of the "postbuild" script).
// Format follows the llms.txt convention — see https://llmstxt.org.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PROJECTS = path.join(ROOT, 'content', 'projects.md')
const COLOPHON = path.join(ROOT, 'content', 'colophon.md')
const NOW = path.join(ROOT, 'content', 'now.md')
const USES = path.join(ROOT, 'content', 'uses.md')
const PHOTOS = path.join(ROOT, 'src', 'lib', 'photos.json')
const BLOG = path.join(ROOT, 'content', 'blog')
const DIST = path.join(ROOT, 'dist')
const SITE = 'https://cailinpitt.com'
const SITE_NAME = 'Cailin Pitt'
const TAGLINE = 'Photography, software projects, and writing by Cailin Pitt.'

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

/**
 * The counts content/colophon.md quotes as {{placeholders}}, so this file can
 * carry the same prose the page shows instead of raw template syntax.
 *
 * The page gets these from the route loader; here they're read straight off the
 * photo manifest, which is one flat list of every photo. Word count is
 * deliberately absent: the prose
 * doesn't currently quote it, and mirroring countWords() from src/lib/posts.ts
 * would be real logic kept in two places for no reader's benefit. If the prose
 * starts using it, fillTemplate below will say so loudly rather than quietly
 * shipping "{{words}}".
 */
async function colophonValues(posts) {
  const photos = JSON.parse(await readFile(PHOTOS, 'utf8'))
  return {
    posts: posts.length,
    photos: photos.length,
    years: new Set(photos.map((photo) => photo.year)).size,
    located: photos.filter((photo) => photo.exif?.place?.length === 2).length,
  }
}

// Mirrors fillTemplate in src/lib/colophon.ts — same two forms: {{key}} for a
// value, {{#key}}…{{/key}} for a block kept only when that count is non-zero.
function fillTemplate(body, values) {
  const present = (key) => {
    const value = values[key]
    return value !== undefined && value !== '' && value !== 0
  }
  return body
    .replace(/\{\{#(\w+)\}\}\s*([\s\S]*?)\s*\{\{\/\1\}\}/g, (match, key, inner) =>
      key in values ? (present(key) ? inner : '') : match,
    )
    .replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const value = values[key]
      if (value === undefined) return match
      return typeof value === 'number' ? value.toLocaleString('en-US') : value
    })
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('✗ No dist/ — run `npm run build` first.')
    process.exit(1)
  }

  const files = (await readdir(BLOG)).filter((f) => f.endsWith('.md'))
  const projectsRaw = await readFile(PROJECTS, 'utf8')
  const projects = parseFrontmatter(projectsRaw)
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

  const nowRaw = parseFrontmatter(await readFile(NOW, 'utf8'))
  const usesRaw = parseFrontmatter(await readFile(USES, 'utf8'))
  const colophonRaw = parseFrontmatter(await readFile(COLOPHON, 'utf8'))
  const colophonBody = fillTemplate(colophonRaw.body, await colophonValues(posts))
  // A placeholder that survived means the prose asked for a count this script
  // doesn't know how to compute. Fail rather than publish the template syntax to
  // the one file whose whole audience reads it literally.
  const unresolved = colophonBody.match(/\{\{[^}]*\}\}/g)
  if (unresolved) {
    console.error(
      `✗ content/colophon.md uses ${[...new Set(unresolved)].join(', ')}, which generate-llms.mjs ` +
        'cannot fill. Add it to colophonValues() in this script.',
    )
    process.exit(1)
  }

  const index = [
    `# ${SITE_NAME}`,
    '',
    `> ${TAGLINE}`,
    '',
    // First, because it is the page that answers "what is this person doing".
    '## Now',
    '',
    `- [${nowRaw.data.title ?? 'Now'}](${SITE}/now)${nowRaw.data.description ? `: ${nowRaw.data.description}` : ''}`,
    '',
    '## Projects',
    '',
    `- [${projects.data.title ?? 'Projects'}](${SITE}/projects)${projects.data.description ? `: ${projects.data.description}` : ''}`,
    '',
    '## Setup',
    '',
    `- [${usesRaw.data.title ?? 'Uses'}](${SITE}/uses)${usesRaw.data.description ? `: ${usesRaw.data.description}` : ''}`,
    '',
    '## About this site',
    '',
    `- [${colophonRaw.data.title ?? 'Colophon'}](${SITE}/colophon)${colophonRaw.data.description ? `: ${colophonRaw.data.description}` : ''}`,
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
    '---',
    '',
    `# ${nowRaw.data.title ?? 'Now'}`,
    `${SITE}/now`,
    '',
    cleanBody(nowRaw.body),
    '',
    '---',
    '',
    `# ${projects.data.title ?? 'Projects'}`,
    `${SITE}/projects`,
    '',
    cleanBody(projects.body),
    '',
    '---',
    '',
    `# ${usesRaw.data.title ?? 'Uses'}`,
    `${SITE}/uses`,
    '',
    cleanBody(usesRaw.body),
    '',
    '---',
    '',
    `# ${colophonRaw.data.title ?? 'Colophon'}`,
    `${SITE}/colophon`,
    '',
    cleanBody(colophonBody),
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
  console.log(`✓ llms.txt + llms-full.txt (${posts.length} posts, now, projects, uses, colophon)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
