#!/usr/bin/env node
// npm run blog:draft [-- "<title>"]
//
// Scaffolds content/blog/<slug>.md with the frontmatter block npm run blog:post expects
// (title, date, path, slug, tags, description, image). The slug comes from the title.
// Prompts for anything not passed; everything but the title can be left blank.

import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BLOG = path.join(ROOT, 'content', 'blog')

// Apostrophes are dropped rather than split on, so "We're" → "were", not "we-re".
const slugify = (value) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f'’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

function fail(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function frontmatter(fm) {
  const lines = [
    '---',
    `title: ${JSON.stringify(fm.title)}`,
    `date: ${fm.date}`,
    `path: ${fm.path}`,
    `slug: ${fm.slug}`,
    `tags: ${JSON.stringify(fm.tags)}`,
    `description: ${JSON.stringify(fm.description)}`,
  ]
  if (fm.image) lines.push(`image: ${JSON.stringify(fm.image)}`)
  lines.push('---', '', '')
  return lines.join('\n')
}

async function main() {
  const rl = createInterface({ input: stdin })
  const lines = rl[Symbol.asyncIterator]()
  const ask = async (q, fallback) => {
    stdout.write(fallback ? `${q} [${fallback}]: ` : `${q}: `)
    const { value, done } = await lines.next()
    const answer = done ? '' : value.trim()
    return answer || fallback || ''
  }

  const title =
    process.argv
      .slice(2)
      .filter((a) => !a.startsWith('-'))
      .join(' ')
      .trim() || (await ask('Title'))
  if (!title) fail('a title is required.')

  const slug = slugify(title)
  if (!slug) fail(`"${title}" has nothing to make a slug from.`)

  const file = path.join(BLOG, `${slug}.md`)
  if (existsSync(file)) fail(`content/blog/${slug}.md already exists.`)
  console.log(`  → content/blog/${slug}.md`)

  const description = await ask('Description (optional)', '')
  const tagsInput = await ask('Tags, comma-separated (optional)', '')
  const image = await ask('Cover image (optional)', '')
  rl.close()

  const now = new Date()
  const [y, m, d] = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const urlPath = `/blog/${y}/${m}/${d}/${slug}`
  const tags = tagsInput
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  await mkdir(BLOG, { recursive: true })
  await writeFile(file, frontmatter({ title, date, path: urlPath, slug, tags, description, image }))

  console.log(`\n✓ created content/blog/${slug}.md`)
  console.log('\nNext:')
  console.log(`    drop image originals in originals/${slug}/`)
  console.log('    npm run dev            # preview')
  console.log(`    npm run blog:post -- ${slug}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
