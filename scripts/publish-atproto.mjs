#!/usr/bin/env node
// Publish standard.site (AT Protocol) records for every blog post — Phase 8.
//
// Upserts one `site.standard.publication` record and one `site.standard.document`
// record per post into your AT Protocol repo (PDS), so the posts render as
// first-class long-form documents in the Bluesky / AT Protocol ecosystem.
//
// Idempotent: the standard.site lexicons declare `key: tid`, so record keys are
// PDS-assigned TIDs rather than stable strings. Re-runs match existing records by
// `url` (publication) and `path` (documents) and update those in place. Legacy
// records keyed by `self`/slug from before the lexicon change are deleted on sight.
//
// The resulting AT-URIs are written to content/atproto.json, which the build reads
// to emit /.well-known/site.standard.publication and the per-post <link> tags. That
// file is committed, so CI builds need no credentials and no network.
//
// Usage:
//   BLUESKY_IDENTIFIER=you.bsky.social BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
//     npm run publish:atproto [-- --dry-run]
//
// Create an app password at https://bsky.app/settings/app-passwords — never use your
// real account password. Optional: BLUESKY_PDS (defaults to https://bsky.social).
//
// Lexicons: https://standard.site/docs/lexicons/document  (verified 2026-06).

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AtpAgent } from '@atproto/api'

// Load local secrets from .env (Bluesky creds live there; gitignored). No-op if the
// file is absent or the Node version predates process.loadEnvFile (env vars can still
// be supplied inline). Available in Node 20.12+.
try {
  process.loadEnvFile?.()
} catch {
  /* no .env present — fall back to whatever is already in process.env */
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BLOG = path.join(ROOT, 'content', 'blog')
const RECORDS_FILE = path.join(ROOT, 'content', 'atproto.json')
// Square author/publication icon (≥256px, <1MB). Uploaded as a blob and referenced
// by the publication record so it shows as the author avatar in standard.site readers.
const ICON_FILE = path.join(ROOT, 'content', 'atproto-icon.jpg')

const SITE_URL = 'https://cailinpitt.com'
// Publication landing (the reader's "View publication" button). Kept at the site root:
// although standard.site's spec describes path-based publications (with a path-appended
// well-known), Bluesky's crawler did not honor that in practice — a /blog url dropped the
// enhanced card back to a plain preview. Root is the verified-working value.
const PUBLICATION_URL = SITE_URL
const PUBLICATION = {
  name: 'Cailin Pitt',
  description: 'Photography and writing by Cailin Pitt.',
}

const DRY_RUN = process.argv.includes('--dry-run')

// --- frontmatter (mirrors src/lib/frontmatter.ts / scripts/generate-llms.mjs) ---
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

// Reduce a Markdown/HTML body to readable plaintext for the document's textContent.
function toPlainText(body) {
  return body
    .replace(/<\/?[^>]+>/g, '') // HTML tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/^#{1,6}\s+/gm, '') // ATX headings
    .replace(/[*_`>]/g, '') // emphasis / code / blockquote markers
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// atproto TID: 13 chars, base32-sortable, restricted first char.
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/

const rkeyOf = (uri) => uri.split('/').pop()

async function listRecords(agent, did, collection) {
  const records = []
  let cursor
  do {
    const res = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection,
      limit: 100,
      cursor,
    })
    records.push(...res.data.records)
    cursor = res.data.cursor
  } while (cursor)
  return records
}

// Drop records whose key predates the `key: tid` lexicon change — they can no
// longer be written to, so re-running would leave stale duplicates behind.
async function deleteLegacy(agent, did, collection, records) {
  for (const rec of records) {
    const rkey = rkeyOf(rec.uri)
    if (TID_RE.test(rkey)) continue
    await agent.com.atproto.repo.deleteRecord({ repo: did, collection, rkey })
    console.log(`✓ removed legacy ${collection}/${rkey}`)
  }
}

// Update the record at `rkey` if given, otherwise create one with a PDS-assigned TID.
async function upsert(agent, did, collection, record, rkey) {
  const res = rkey
    ? await agent.com.atproto.repo.putRecord({ repo: did, collection, rkey, record })
    : await agent.com.atproto.repo.createRecord({ repo: did, collection, record })
  return res.data.uri
}

function isoDateTime(date) {
  if (!date) return new Date().toISOString()
  // Frontmatter dates are "YYYY-MM-DD"; promote to a full UTC datetime.
  return date.includes('T') ? new Date(date).toISOString() : `${date}T00:00:00.000Z`
}

async function loadPosts() {
  const files = (await readdir(BLOG)).filter((f) => f.endsWith('.md'))
  const posts = []
  for (const f of files) {
    const { data, body } = parseFrontmatter(await readFile(path.join(BLOG, f), 'utf8'))
    const slug = f.replace(/\.md$/, '')
    posts.push({
      slug,
      title: data.title ?? slug,
      date: data.date ?? '',
      path: data.path ?? `/blog/${slug}`,
      description: data.description ?? '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      textContent: toPlainText(body),
    })
  }
  return posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

async function main() {
  const identifier = process.env.BLUESKY_IDENTIFIER
  const password = process.env.BLUESKY_APP_PASSWORD
  const service = process.env.BLUESKY_PDS || 'https://bsky.social'

  const posts = await loadPosts()
  console.log(`Found ${posts.length} posts.`)

  if (DRY_RUN) {
    console.log('\n--dry-run: no records will be written.\n')
    for (const p of posts) {
      console.log(`  document  ${p.path}  (${p.textContent.length} chars)`)
    }
    return
  }

  if (!identifier || !password) {
    console.error(
      '✗ Set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD.\n' +
        '  Create an app password at https://bsky.app/settings/app-passwords\n' +
        '  Tip: run with --dry-run to preview without credentials.',
    )
    process.exit(1)
  }

  const agent = new AtpAgent({ service })
  await agent.login({ identifier, password })
  const did = agent.session.did
  console.log(`Logged in as ${did} via ${service}`)

  // 1. Publication record.
  const existingPubs = await listRecords(agent, did, 'site.standard.publication')
  await deleteLegacy(agent, did, 'site.standard.publication', existingPubs)
  const pubMatch = existingPubs.find(
    (r) => TID_RE.test(rkeyOf(r.uri)) && r.value.url === PUBLICATION_URL,
  )

  // Upload the icon blob last, right before the record that references it: an
  // unreferenced blob is only briefly retained, and deleting the old publication
  // record above can sweep a same-CID blob it still held.
  let icon
  if (existsSync(ICON_FILE)) {
    const bytes = await readFile(ICON_FILE)
    const up = await agent.com.atproto.repo.uploadBlob(bytes, { encoding: 'image/jpeg' })
    icon = up.data.blob
    console.log(`✓ uploaded icon (${(bytes.length / 1024).toFixed(0)} KB)`)
  }
  const pubUri = await upsert(
    agent,
    did,
    'site.standard.publication',
    {
      $type: 'site.standard.publication',
      url: PUBLICATION_URL,
      name: PUBLICATION.name,
      description: PUBLICATION.description,
      ...(icon ? { icon } : {}),
    },
    pubMatch && rkeyOf(pubMatch.uri),
  )
  console.log(`✓ publication → ${pubUri}`)

  // 2. Document record per post, matched to any existing record by `path`.
  const existingDocs = await listRecords(agent, did, 'site.standard.document')
  await deleteLegacy(agent, did, 'site.standard.document', existingDocs)
  const docRkeyByPath = new Map(
    existingDocs
      .filter((r) => TID_RE.test(rkeyOf(r.uri)))
      .map((r) => [r.value.path, rkeyOf(r.uri)]),
  )

  const documents = {}
  for (const p of posts) {
    const uri = await upsert(
      agent,
      did,
      'site.standard.document',
      {
        $type: 'site.standard.document',
        site: pubUri,
        path: p.path,
        title: p.title,
        ...(p.description ? { description: p.description } : {}),
        ...(p.tags.length ? { tags: p.tags } : {}),
        textContent: p.textContent,
        publishedAt: isoDateTime(p.date),
      },
      docRkeyByPath.get(p.path),
    )
    documents[p.path] = uri
    console.log(`✓ document   ${p.path} → ${uri}`)
  }

  await writeFile(
    RECORDS_FILE,
    JSON.stringify({ did, publication: pubUri, publicationUrl: PUBLICATION_URL, documents }, null, 2) + '\n',
    'utf8',
  )
  console.log(`\n✓ Wrote ${path.relative(ROOT, RECORDS_FILE)} (${posts.length} documents).`)
  console.log('  Commit it, then rebuild so the build emits .well-known + <link> tags.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
