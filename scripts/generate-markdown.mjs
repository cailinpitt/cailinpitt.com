#!/usr/bin/env node
// Copy each post's Markdown source next to its prerendered HTML, so
// /blog/2023/3/3/slug also answers at /blog/2023/3/3/slug.md — the raw file the
// page was built from. Runs after `npm run build` (part of "postbuild").
//
// The file is published byte-for-byte, frontmatter included: the point is to
// hand over the actual source, not a reconstruction of it. Body images still
// point at /images/... rather than the R2 host they're rewritten to at render
// time, which is what the source says and what you'd paste back into a post.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BLOG = path.join(ROOT, 'content', 'blog')
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
  console.log(`✓ ${files.length} post sources copied to dist/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
