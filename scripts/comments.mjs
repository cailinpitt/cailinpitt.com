#!/usr/bin/env node
// Moderate blog comments from the command line. See scripts/guestbook.mjs, which this mirrors.
//
//   npm run comments:list                    # 50 newest
//   npm run comments:list -- --limit 200
//   npm run comments:rm -- <id> [<id> ...]   # immediate and permanent

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* fall back to the ambient environment */
}

const args = process.argv.slice(2)
const command = args[0]

const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const API = flag('api') ?? process.env.COMMENTS_API ?? 'https://comments.cailinpitt.com'

const TOKEN = process.env.COMMENTS_ADMIN_TOKEN
if (!TOKEN) {
  console.error("✗ Missing COMMENTS_ADMIN_TOKEN in .env (the Worker's ADMIN_TOKEN secret).")
  process.exit(1)
}

const auth = { authorization: `Bearer ${TOKEN}` }

const dim = (s) => `\x1b[38;5;244m${s}\x1b[0m`
const accent = (s) => `\x1b[38;5;173m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

const safe = (s) => String(s ?? '').replace(/\p{Cc}|\p{Cf}/gu, ' ')

const stamp = (uts) =>
  new Date(uts * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

async function list() {
  const limit = Number(flag('limit')) || 50
  const res = await fetch(`${API}/admin/comments?limit=${limit}`, { headers: auth })
  if (!res.ok) {
    console.error(`✗ ${res.status} ${res.statusText} from ${API}/admin/comments`)
    process.exit(1)
  }
  const { comments } = await res.json()

  if (!comments.length) {
    console.log(dim('No comments yet.'))
    return
  }

  const byHash = new Map()
  for (const c of comments) byHash.set(c.ipHash, (byHash.get(c.ipHash) ?? 0) + 1)

  for (const c of comments) {
    const repeat = byHash.get(c.ipHash)
    console.log(
      `${accent(c.id)}  ${bold(safe(c.name))}` +
        dim(`  ${safe(c.postPath)}`) +
        dim(`  ${stamp(c.createdAt)}`) +
        (repeat > 1 ? dim(`  [${repeat}x from ${c.ipHash.slice(0, 8)}]`) : ''),
    )
    if (c.website) console.log(dim(`  ${safe(c.website)}`))
    for (const line of safe(c.message).split('\n')) console.log(`  ${line}`)
    console.log()
  }
  console.log(dim(`${comments.length} shown. Delete with: npm run comments:rm -- <id>`))
}

async function remove() {
  const ids = args.slice(1).filter((a, i, all) => {
    if (a.startsWith('--')) return false
    const prev = all[i - 1]
    return !(prev && prev.startsWith('--'))
  })

  if (!ids.length) {
    console.error('✗ Usage: npm run comments:rm -- <id> [<id> ...]')
    process.exit(1)
  }

  let failed = 0
  for (const id of ids) {
    const res = await fetch(`${API}/comments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: auth,
    })
    if (res.ok) {
      console.log(`✓ deleted ${id}`)
    } else {
      failed++
      console.error(`✗ ${id}: ${res.status} ${res.statusText}`)
    }
  }
  if (failed) process.exit(1)
}

if (command === 'list') await list()
else if (command === 'rm') await remove()
else {
  console.error('Usage: comments.mjs list|rm [args]')
  process.exit(1)
}
