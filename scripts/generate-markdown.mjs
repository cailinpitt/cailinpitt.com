#!/usr/bin/env node
// Copy each Markdown source next to the prerendered HTML it produced

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CONTENT = path.join(ROOT, 'content')
const BLOG = path.join(CONTENT, 'blog')
const DIST = path.join(ROOT, 'dist')

// Mirrors src/lib/frontmatter.ts; only `path` is needed here.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function postPath(file, raw) {
  const slug = file.replace(/\.md$/, '')
  const block = raw.match(FRONTMATTER_RE)?.[1]
  for (const line of block?.split(/\r?\n/) ?? []) {
    const sep = line.indexOf(':')
    if (sep === -1 || line.slice(0, sep).trim() !== 'path') continue
    const value = line.slice(sep + 1).trim()
    return value.replace(/^['"]|['"]$/g, '')
  }
  return `/blog/${slug}`
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('✗ No dist/ — run `npm run build` first.')
    process.exit(1)
  }

  const files = (await readdir(BLOG)).filter((f) => f.endsWith('.md'))
  for (const file of files) {
    const raw = await readFile(path.join(BLOG, file), 'utf8')
    const out = path.join(DIST, `${postPath(file, raw).replace(/^\//, '')}.md`)
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, raw, 'utf8')
  }

  // A .md directly in content/ is a page whose route is its name: /colophon.md.
  // Read from the directory, so a page added later needs nothing here.
  const pages = (await readdir(CONTENT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
  for (const file of pages) {
    const raw = await readFile(path.join(CONTENT, file), 'utf8')
    await writeFile(path.join(DIST, file), raw, 'utf8')
  }

  console.log(`✓ ${files.length} post and ${pages.length} page sources copied to dist/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
