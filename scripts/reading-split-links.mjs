#!/usr/bin/env node
// One-off: sort existing rows in the reading Worker's `articles` table into
// "still an article" vs "actually just a link", then move the links across.
//
//   npm run reading:split-links               # dump every article to a review file
//   npm run reading:split-links -- --apply    # move the rows marked `link`
//   npm run reading:split-links -- --api http://localhost:8787
//
// Two passes on purpose:
//
//   1. No flag — pages GET /articles to the end and writes
//      scripts/.reading-split.tsv, one row per article, column 1 a guess
//      (`link` or `article`). Edit that column by hand.
//   2. --apply — for every row whose column 1 is `link`, POST /ingest with
//      {"kind":"link"}. That call moves the row (insert into `links`, delete the
//      `articles` row, fix both counters). Idempotent; safe to re-run.
//
// Needs INGEST_TOKEN in .env (the Worker's INGEST_TOKEN secret) for --apply.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* fall back to the ambient environment */
}

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const apiArg = args.indexOf('--api')
const API =
  (apiArg >= 0 ? args[apiArg + 1] : process.env.READING_API) ?? 'https://reading.cailinpitt.com'
const FILE = path.join(ROOT, 'scripts', '.reading-split.tsv')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A conservative guess that a saved "article" is really just a link: default is
 * `article`, so a wrong guess only ever leaves a link mislabelled for you to fix
 * in the file — it never moves something on its own.
 */
function guessKind(article) {
  let url
  try {
    url = new URL(article.url)
  } catch {
    return 'article'
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  const host = url.hostname.replace(/^www\./, '')

  // A bare domain or a one-hop path is almost always "here's a site", not a read.
  if (segments.length === 0) return 'link'
  if (segments.length === 1 && last.length <= 24 && (last.match(/-/g)?.length ?? 0) <= 1) return 'link'

  // Shallow path AND no description AND a title that's just the host (or none,
  // usually meaning enrichment never found one): probably a link, not a read.
  // A deep path (date segments, /blog/…, /news/articles/…) stays an article even
  // with a pending title.
  const title = (article.title ?? '').trim()
  if (
    segments.length <= 2 &&
    !article.excerpt &&
    (!title || title.toLowerCase() === host || title === article.site)
  ) {
    return 'link'
  }
  return 'article'
}

async function fetchAllArticles() {
  const all = []
  let cursor = ''
  for (;;) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : '?limit=50'
    const res = await fetch(`${API}/articles${qs}`)
    if (!res.ok) throw new Error(`GET /articles → HTTP ${res.status}`)
    const page = await res.json()
    all.push(...page.articles)
    if (!page.nextCursor) return all
    cursor = page.nextCursor
  }
}

async function dump() {
  console.log(`→ ${API}/articles`)
  const articles = await fetchAllArticles()
  const lines = ['# kind\tid\turl\ttitle  —  edit column 1 to link/article, then: npm run reading:split-links -- --apply']
  let guessed = 0
  for (const a of articles) {
    const kind = guessKind(a)
    if (kind === 'link') guessed++
    lines.push([kind, a.id, a.url, (a.title ?? '').replace(/\s+/g, ' ')].join('\t'))
  }
  await writeFile(FILE, lines.join('\n') + '\n', 'utf8')
  console.log(
    `  wrote ${articles.length} rows to ${path.relative(ROOT, FILE)} ` +
      `(${guessed} guessed as links). Review it, then re-run with --apply.`,
  )
}

async function apply() {
  const token = process.env.INGEST_TOKEN
  if (!token) {
    console.error("✗ Missing INGEST_TOKEN in .env (the Worker's INGEST_TOKEN secret).")
    process.exit(1)
  }

  let raw
  try {
    raw = await readFile(FILE, 'utf8')
  } catch {
    console.error(`✗ ${path.relative(ROOT, FILE)} not found — run without --apply first.`)
    process.exit(1)
  }

  const targets = raw
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((cols) => cols[0]?.trim() === 'link' && cols[2])
    .map((cols) => cols[2].trim())

  if (!targets.length) {
    console.log('Nothing marked `link` in the review file. Done.')
    return
  }

  console.log(`Moving ${targets.length} row(s) to the links table…`)
  let moved = 0
  let failed = 0
  for (const url of targets) {
    try {
      const res = await fetch(`${API}/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url, kind: 'link' }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      moved++
      console.log(`  ✓ ${url}${body.moved ? ' (moved)' : ''}`)
    } catch (err) {
      failed++
      console.log(`  ✗ ${url} — ${err.message}`)
    }
    await sleep(150)
  }
  console.log(`\n${moved} moved, ${failed} failed. The next hourly sync reconciles both counts.`)
}

;(APPLY ? apply() : dump()).catch((err) => {
  console.error(`\n✗ ${err.message}`)
  process.exit(1)
})
