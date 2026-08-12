#!/usr/bin/env node
// Renders one note's OG card and uploads it to R2 — the async half of the
// per-note card pipeline (see worker-notes/src/index.ts for the dispatch that
// triggers this, and the Context section of the plan for why this can't run
// inside the Worker itself).
//
//   node scripts/generate-note-og.mjs --id <id>              render + upload
//   node scripts/generate-note-og.mjs --id <id> --out <dir>  render to a local file instead

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { W, H, loadFonts, col, row, text, fitSize, renderCard } from './og-shared.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* no .env — fall back to whatever is already in the environment */
}

const SITE = 'https://cailinpitt.com'

const args = process.argv.slice(2)
const id = args.includes('--id') ? args[args.indexOf('--id') + 1] : null
const outDir = args.includes('--out') ? path.resolve(ROOT, args[args.indexOf('--out') + 1]) : null

if (!id) {
  console.error('✗ --id <note id> is required')
  process.exit(1)
}

const C = { bg: '#faf8f4', fg: '#1b1a17', muted: '#766f64' }

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// The minimal single-note page, as a card: no spine, no kicker — the note's own
// text on the paper background, with the same small identity mark the page
// itself shows once the site header is gone (see .notes-back-home in global.css).
function noteCard({ text: body, createdAt }) {
  const size = fitSize(body, 960, 7, 48, 28)
  return col(
    { width: W, height: H, background: C.bg, padding: '70px 120px', justifyContent: 'center' },
    text({ fontFamily: 'Serif', color: C.fg, lineHeight: 1.5, fontSize: size, whiteSpace: 'pre-wrap' }, body),
    row(
      { marginTop: 40, alignItems: 'baseline' },
      text({ fontFamily: 'Serif', fontWeight: 600, fontSize: 22, color: C.fg, marginRight: 14 }, 'Cailin Pitt'),
      text({ fontFamily: 'Sans', fontSize: 20, color: C.muted }, dateFmt.format(createdAt * 1000)),
    ),
  )
}

async function fetchNote(noteId) {
  const res = await fetch(`${SITE}/notes/${noteId}?format=json`)
  if (!res.ok) throw new Error(`fetching note ${noteId}: ${res.status}`)
  const { note } = await res.json()
  return note
}

async function upload(key, body) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env
  for (const [k, v] of Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET })) {
    if (!v) {
      console.error(`✗ Missing env var ${k}. See scripts/upload-r2.mjs for the same requirement.`)
      process.exit(1)
    }
  }
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  })
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'image/jpeg',
      // Short, not the photo renditions' immutable — an edited note re-renders
      // and overwrites this same key.
      CacheControl: 'public, max-age=300',
    }),
  )
}

async function main() {
  const note = await fetchNote(id)
  const fonts = await loadFonts()
  const buf = await renderCard(noteCard(note), fonts)

  if (outDir) {
    await mkdir(outDir, { recursive: true })
    const out = path.join(outDir, `${id}.jpg`)
    await writeFile(out, buf)
    console.log(`✓ wrote ${path.relative(ROOT, out)}`)
    return
  }

  const key = `og/notes/${id}.jpg`
  await upload(key, buf)
  console.log(`✓ uploaded ${key}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
