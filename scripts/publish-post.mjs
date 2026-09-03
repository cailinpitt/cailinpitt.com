#!/usr/bin/env node
// npm run post [-- <slug>] [--dry-run] [--skip-images] [--skip-atproto]

import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BLOG = path.join(ROOT, 'content', 'blog')

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const SKIP_IMAGES = args.includes('--skip-images')
const SKIP_ATPROTO = args.includes('--skip-atproto')
const REQUIRED_KEYS = ['title', 'date', 'path', 'slug', 'description', 'image']

const slugArg = args.find((a) => !a.startsWith('-'))

function run(cmd, cmdArgs) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`)
  execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' })
}

function git(cmdArgs) {
  return execFileSync('git', cmdArgs, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function fail(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return {}
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    data[line.slice(0, sep).trim()] = line.slice(sep + 1).trim().replace(/^["']|["']$/g, '')
  }
  return data
}

async function resolveSlug() {
  if (slugArg) return slugArg.replace(/\.md$/, '')

  const changed = git(['status', '--porcelain', '--', 'content/blog'])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter((f) => f.endsWith('.md'))

  if (changed.length === 0) fail('no changed post under content/blog — pass a slug explicitly.')
  if (changed.length > 1) {
    fail(
      'several changed posts — pass one slug explicitly:\n' +
        changed.map((f) => `    ${path.basename(f, '.md')}`).join('\n'),
    )
  }
  return path.basename(changed[0], '.md')
}

async function main() {
  const slug = await resolveSlug()
  const file = path.join(BLOG, `${slug}.md`)
  if (!existsSync(file)) fail(`content/blog/${slug}.md does not exist.`)

  console.log(`Post: ${slug}${DRY_RUN ? '  (dry run)' : ''}`)

  const raw = await readFile(file, 'utf8')
  const fm = parseFrontmatter(raw)
  const missing = REQUIRED_KEYS.filter((k) => !fm[k])
  if (missing.length) fail(`content/blog/${slug}.md is missing frontmatter: ${missing.join(', ')}`)
  if (fm.slug !== slug) fail(`frontmatter slug "${fm.slug}" does not match filename "${slug}".`)

  const originals = path.join(ROOT, 'originals', slug)
  const hasOriginals =
    existsSync(originals) && (await readdir(originals)).some((f) => !f.startsWith('.'))
  const bodyRefsImages = new RegExp(`/images/${slug}/`).test(raw)
  if (bodyRefsImages && !hasOriginals && !existsSync(path.join(ROOT, 'images', slug))) {
    console.warn(
      `\n! post references /images/${slug}/ but originals/${slug}/ is empty — assuming they're already in R2.`,
    )
  }

  if (SKIP_IMAGES || !hasOriginals) {
    console.log(
      `\n· images: ${SKIP_IMAGES ? 'skipped' : `no originals/${slug}/ — nothing to encode`}`,
    )
    if (!SKIP_IMAGES && !DRY_RUN) run('npm', ['run', 'images:upload'])
  } else if (DRY_RUN) {
    run('npm', ['run', 'images:upload', '--', '--dry-run'])
  } else {
    run('npm', ['run', 'images:sync'])
    run('npm', ['run', 'images:upload'])
  }

  if (SKIP_ATPROTO) {
    console.log('\n· atproto: skipped')
  } else {
    run('npm', ['run', 'publish:atproto', ...(DRY_RUN ? ['--', '--dry-run'] : [])])
  }

  if (DRY_RUN) {
    console.log('\n✓ dry run complete — nothing staged.')
    return
  }
  run('git', ['add', 'content/blog', 'content/atproto.json', 'src/lib/photos.json'])

  console.log(`\n✓ staged:\n${git(['diff', '--cached', '--stat']) || '  (nothing)'}`)
  console.log(`\nNext:\n    git commit -m ${JSON.stringify(fm.title)}\n    git push\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
