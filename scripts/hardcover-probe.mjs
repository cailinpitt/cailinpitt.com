#!/usr/bin/env node
// Probe the hardcover.app API with the *exact* queries worker-reading uses, so
// the query shape can be validated before any of it is deployed.
//
//   node scripts/hardcover-probe.mjs            # summary + a few sample rows
//   node scripts/hardcover-probe.mjs --json     # the normalized rows, as JSON
//   node scripts/hardcover-probe.mjs --limit 5  # stop after N pages
//
// Needs HARDCOVER_TOKEN in .env (create one at https://hardcover.app/account/api).
//
// This deliberately duplicates the queries in worker-reading/src/hardcover.ts
// rather than importing them (that file is TypeScript, and Workers types don't
// load in plain node) — the same trade-off scripts/backfill-listening.mjs makes
// with lastfm.ts. If you change one, change the other.
//
// Hardcover caps **query depth at 3**, so authors cannot be reached through
// user_books → book → contributions → author. They don't need to be: the
// books.cached_contributors jsonb column already carries each author's name and
// role, so the whole library comes back in one paged query.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* fall back to the ambient environment */
}

const ENDPOINT = 'https://api.hardcover.app/v1/graphql'
const PAGE_SIZE = 100

const args = process.argv.slice(2)
const AS_JSON = args.includes('--json')
const limitArg = args.indexOf('--limit')
const MAX_PAGES = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity

const TOKEN = process.env.HARDCOVER_TOKEN
if (!TOKEN) {
  console.error('✗ Missing HARDCOVER_TOKEN. Add it to .env — see https://hardcover.app/account/api')
  process.exit(1)
}

const STATUS = { 1: 'want to read', 2: 'reading', 3: 'read', 4: 'paused', 5: 'did not finish' }

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      // The token from the account page already starts with "Bearer " for some
      // users and not others; normalize so either form works.
      authorization: TOKEN.startsWith('Bearer ') ? TOKEN : `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'cailinpitt.com-reading/1.0 (+https://cailinpitt.com)',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }
  const body = await res.json()
  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`)
  }
  return body.data
}

const LIBRARY_QUERY = `
  query Library($userId: Int!, $limit: Int!, $offset: Int!) {
    user_books(
      where: { user_id: { _eq: $userId } }
      order_by: { id: asc }
      limit: $limit
      offset: $offset
    ) {
      id
      book_id
      status_id
      rating
      book {
        title
        slug
        pages
        cached_image
        cached_contributors
      }
      user_book_reads(order_by: { id: asc }) {
        id
        started_at
        finished_at
      }
    }
  }`


function asJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function coverUrl(cached) {
  const value = asJson(cached)
  if (typeof value === 'string') return value.startsWith('http') ? value : null
  if (!value || typeof value !== 'object') return null
  return typeof value.url === 'string' && value.url.startsWith('http') ? value.url : null
}

const isAuthorCredit = (role) =>
  role == null || (typeof role === 'string' && (role.trim() === '' || /^author$/i.test(role.trim())))

function authorsFrom(cached) {
  const list = asJson(cached)
  if (!Array.isArray(list)) return null
  const authors = []
  const everyone = []
  for (const entry of list) {
    const name = entry?.author?.name
    if (typeof name !== 'string' || !name.trim()) continue
    // Hardcover's data has stray double spaces in some names ("Ben  Reeves").
    const clean = name.replace(/\s+/g, ' ').trim()
    if (!everyone.includes(clean)) everyone.push(clean)
    if (isAuthorCredit(entry?.contribution) && !authors.includes(clean)) authors.push(clean)
  }
  const names = authors.length ? authors : everyone
  return names.length ? names.join(', ') : null
}

async function main() {
  process.stdout.write('→ resolving user… ')
  const me = (await gql(`query Me { me { id username } }`)).me?.[0]
  if (!me?.id) throw new Error('could not resolve the user id from `me`')
  console.log(`${me.username} (id ${me.id})`)

  const raw = []
  for (let page = 0; page < MAX_PAGES; page++) {
    process.stdout.write(`→ user_books page ${page + 1}… `)
    const data = await gql(LIBRARY_QUERY, {
      userId: me.id,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
    const rows = data.user_books ?? []
    console.log(`${rows.length} row(s)`)
    raw.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }


  // Same flattening the worker does: one row per read session.
  const rows = []
  for (const ub of raw) {
    const base = {
      userBookId: ub.id,
      bookId: ub.book_id,
      title: ub.book?.title?.trim() || 'Untitled',
      authors: authorsFrom(ub.book?.cached_contributors),
      slug: ub.book?.slug ?? null,
      coverSource: coverUrl(ub.book?.cached_image),
      pages: ub.book?.pages ?? null,
      rating: ub.rating ?? null,
      statusId: ub.status_id,
    }
    const reads = ub.user_book_reads ?? []
    if (!reads.length) {
      rows.push({ ...base, readId: 0, startedAt: null, finishedAt: null })
      continue
    }
    for (const r of reads) {
      rows.push({ ...base, readId: r.id, startedAt: r.started_at, finishedAt: r.finished_at })
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  const byStatus = new Map()
  for (const r of rows) byStatus.set(r.statusId, (byStatus.get(r.statusId) ?? 0) + 1)

  console.log(`\n${raw.length} book(s) → ${rows.length} read-session row(s)`)
  for (const [status, count] of [...byStatus].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${String(count).padStart(4)}  ${STATUS[status] ?? `status ${status}`}`)
  }
  console.log(`  ${String(rows.filter((r) => r.coverSource).length).padStart(4)}  have a cover url`)
  console.log(`  ${String(rows.filter((r) => r.authors).length).padStart(4)}  have an author`)
  console.log(`  ${String(rows.filter((r) => r.finishedAt).length).padStart(4)}  have a finish date`)

  const reading = rows.filter((r) => r.statusId === 2)
  if (reading.length) {
    console.log('\nCurrently reading:')
    for (const r of reading) {
      console.log(`  ${r.title}${r.authors ? ` — ${r.authors}` : ''}  (started ${r.startedAt ?? '—'})`)
    }
  }

  const finished = rows
    .filter((r) => r.finishedAt)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    .slice(0, 5)
  if (finished.length) {
    console.log('\nMost recently finished:')
    for (const r of finished) {
      const rating = r.rating ? ` ${'★'.repeat(Math.round(r.rating))}` : ''
      console.log(`  ${r.finishedAt}  ${r.title}${r.authors ? ` — ${r.authors}` : ''}${rating}`)
    }
  }

  const sample = rows.find((r) => r.coverSource)
  if (sample) console.log(`\nSample cover url: ${sample.coverSource}`)

  const missing = rows.filter((r) => !r.coverSource).length
  if (missing) console.log(`\nNote: ${missing} row(s) have no cover url and will render a placeholder.`)
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`)
  console.error(
    '\nIf this is a depth or field error, the query in this script and in\n' +
      'worker-reading/src/hardcover.ts both need adjusting.',
  )
  process.exit(1)
})
