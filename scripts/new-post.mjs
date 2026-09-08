#!/usr/bin/env node
// npm run blog:draft [-- <slug>]
//
// Scaffolds content/blog/<slug>.md with the frontmatter block npm run blog:post expects
// (title, date, path, slug, tags, description, image). Prompts for anything not
// passed; everything but the slug has a sensible default and can be left blank.

import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BLOG = path.join(ROOT, 'content', 'blog')

const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const titleCase = (slug) =>
  slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')

function fail(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function frontmatter(fm) {
  return [
    '---',
    `title: ${JSON.stringify(fm.title)}`,
    `date: ${fm.date}`,
    `path: ${fm.path}`,
    `slug: ${fm.slug}`,
    `tags: ${JSON.stringify(fm.tags)}`,
    `description: ${JSON.stringify(fm.description)}`,
    `image: ${fm.image}`,
    '---',
    '',
    '',
  ].join('\n')
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

  const rawSlug = process.argv.slice(2).find((a) => !a.startsWith('-')) || (await ask('Slug'))
  const slug = slugify(rawSlug.replace(/\.md$/, ''))
  if (!slug) fail('a slug is required.')

  const file = path.join(BLOG, `${slug}.md`)
  if (existsSync(file)) fail(`content/blog/${slug}.md already exists.`)

  const title = await ask('Title', titleCase(slug))
  const description = await ask('Description (optional)', '')
  const tagsInput = await ask('Tags, comma-separated (optional)', '')
  const image = await ask('Cover image', `/images/${slug}/cover.webp`)
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
