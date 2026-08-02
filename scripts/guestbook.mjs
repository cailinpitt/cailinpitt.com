#!/usr/bin/env node
// Moderate the guestbook from the command line.
//
//   npm run guestbook:list                    # 50 newest entries
//   npm run guestbook:list -- --limit 200     # more
//   npm run guestbook:rm -- <id> [<id> ...]   # delete
//   npm run guestbook:list -- --api http://localhost:8791
//
// Needs GUESTBOOK_ADMIN_TOKEN in .env — the same value stored on the Worker as
// the ADMIN_TOKEN secret (`cd worker-guestbook && npx wrangler secret put
// ADMIN_TOKEN`). Cloudflare secrets are write-only, so .env is the only place
// you can read it back from; if the two drift, the routes return 401 and you
// just re-put both.
//
// Deleting is immediate and permanent — there is no pending state and no trash.
// That is the trade the instant-publish design makes: entries go up without
// waiting on you, and the cleanup is one command.

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

const API = flag('api') ?? process.env.GUESTBOOK_API ?? 'https://guestbook.cailinpitt.com'

const TOKEN = process.env.GUESTBOOK_ADMIN_TOKEN
if (!TOKEN) {
  console.error("✗ Missing GUESTBOOK_ADMIN_TOKEN in .env (the Worker's ADMIN_TOKEN secret).")
  process.exit(1)
}

const auth = { authorization: `Bearer ${TOKEN}` }

// ---- formatting ----------------------------------------------------------

const dim = (s) => `\x1b[38;5;244m${s}\x1b[0m`
const accent = (s) => `\x1b[38;5;173m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

/**
 * Entries are written by strangers and this prints them straight into a
 * terminal, so strip anything that could move the cursor or repaint the screen.
 * The Worker's own text view does the same — see worker-guestbook/src/text.ts.
 */
const safe = (s) => String(s ?? '').replace(/\p{Cc}|\p{Cf}/gu, ' ')

const stamp = (uts) =>
  new Date(uts * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

// ---- commands ------------------------------------------------------------

async function list() {
  const limit = Number(flag('limit')) || 50
  const res = await fetch(`${API}/admin/entries?limit=${limit}`, { headers: auth })
  if (!res.ok) {
    console.error(`✗ ${res.status} ${res.statusText} from ${API}/admin/entries`)
    process.exit(1)
  }
  const { entries } = await res.json()

  if (!entries.length) {
    console.log(dim('No entries yet.'))
    return
  }

  // How many entries each IP bucket accounts for. This is the whole reason the
  // hash is exposed to this view: ten entries under ten names and one hash is
  // one person, and that is invisible on the public page.
  const byHash = new Map()
  for (const e of entries) byHash.set(e.ipHash, (byHash.get(e.ipHash) ?? 0) + 1)

  for (const e of entries) {
    const repeat = byHash.get(e.ipHash)
    const where = [safe(e.location), e.country].filter(Boolean).join(', ')
    console.log(
      `${accent(e.id)}  ${bold(safe(e.name))}${where ? dim(`  ${where}`) : ''}` +
        dim(`  ${stamp(e.createdAt)}`) +
        (repeat > 1 ? dim(`  [${repeat}x from ${e.ipHash.slice(0, 8)}]`) : ''),
    )
    if (e.website) console.log(dim(`  ${safe(e.website)}`))
    for (const line of safe(e.message).split('\n')) console.log(`  ${line}`)
    console.log()
  }
  console.log(dim(`${entries.length} shown. Delete with: npm run guestbook:rm -- <id>`))
}

async function remove() {
  // Everything after the subcommand that isn't a flag or a flag's value.
  const ids = args.slice(1).filter((a, i, all) => {
    if (a.startsWith('--')) return false
    const prev = all[i - 1]
    return !(prev && prev.startsWith('--'))
  })

  if (!ids.length) {
    console.error('✗ Usage: npm run guestbook:rm -- <id> [<id> ...]')
    process.exit(1)
  }

  let failed = 0
  for (const id of ids) {
    const res = await fetch(`${API}/entries/${encodeURIComponent(id)}`, {
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
  // Non-zero on any failure, so this composes with `&&` in a shell.
  if (failed) process.exit(1)
}

if (command === 'list') await list()
else if (command === 'rm') await remove()
else {
  console.error('Usage: guestbook.mjs list|rm [args]')
  process.exit(1)
}
