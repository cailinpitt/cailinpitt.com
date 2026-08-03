#!/usr/bin/env node
// The build half of "publish a photo from my phone".
//
//   node scripts/ingest-photos.mjs --fetch    # pull pending uploads into originals/
//   node scripts/ingest-photos.mjs --finish   # apply alt text, archive, clear the queue
//
// worker-photos/ stores what the Shortcut sends at `incoming/<year>/<name>.jpg`
// in the private originals bucket and fires a repository_dispatch. The workflow
// (.github/workflows/ingest-photos.yml) then runs, in order:
//
//   --fetch  →  npm run images:sync  →  npm run images:upload  →  --finish  →  commit
//
// The two middle steps are the ordinary local pipeline, unchanged: once --fetch
// has put the files in originals/<year>/, a photo from the phone is
// indistinguishable from one added at the laptop. That is the whole point of
// splitting this in two — there is no second code path that publishes photos,
// only a second way of getting the files into originals/.
//
// Required env (same R2 API token as the other scripts, plus the second bucket):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ORIGINALS_BUCKET

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ORIGINALS_DIR = path.join(ROOT, 'originals')
const MANIFEST = path.join(ROOT, 'src', 'lib', 'photos.json')

/**
 * What --fetch found, for --finish to act on after the sync has run. A file
 * rather than one long process because the two halves sandwich `images:sync` and
 * `images:upload`, which are separate commands run by the workflow.
 */
const QUEUE = path.join(ROOT, '.ingest-queue.json')

const INCOMING = 'incoming/'
/** Where an ingested original is kept afterward, in the same private bucket. */
const ARCHIVE = 'originals/'

// Load credentials from the local .env (gitignored) if present, so this can be
// run by hand as well as by CI.
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* no .env — fall back to whatever is already in the environment */
}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ORIGINALS_BUCKET } = process.env

const FETCH = process.argv.includes('--fetch')
const FINISH = process.argv.includes('--finish')

if (FETCH === FINISH) {
  console.error('✗ pass exactly one of --fetch or --finish. See the header of this script.')
  process.exit(1)
}

for (const [key, value] of Object.entries({
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_ORIGINALS_BUCKET,
})) {
  if (!value) {
    console.error(`✗ Missing env var ${key}. See the header of this script.`)
    process.exit(1)
  }
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

// --- fetch -------------------------------------------------------------------

async function listIncoming() {
  const keys = []
  let ContinuationToken
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_ORIGINALS_BUCKET,
        Prefix: INCOMING,
        ContinuationToken,
      }),
    )
    for (const object of page.Contents ?? []) {
      if (!object.Key.endsWith('/')) keys.push(object.Key)
    }
    ContinuationToken = page.NextContinuationToken
  } while (ContinuationToken)
  // Oldest first, so a burst of uploads is ingested in the order it was sent.
  return keys.sort()
}

async function fetchPending() {
  const keys = await listIncoming()
  if (!keys.length) {
    console.log('· nothing waiting in incoming/')
    await writeFile(QUEUE, '[]\n')
    return
  }

  const queue = []
  for (const key of keys) {
    // incoming/<year>/<name>.<ext>
    const [, year, name] = key.split('/')
    if (!/^\d{4}$/.test(year) || !name) {
      console.warn(`  ! skipping ${key} — not incoming/<year>/<file>`)
      continue
    }
    const object = await s3.send(
      new GetObjectCommand({ Bucket: R2_ORIGINALS_BUCKET, Key: key }),
    )
    const dir = path.join(ORIGINALS_DIR, year)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, name), Buffer.from(await object.Body.transformToByteArray()))
    queue.push({
      key,
      year,
      name,
      // The rendition sync will write, which is what ties this back to a
      // manifest entry in --finish.
      src: `/images/${year}/${name.replace(/\.[^.]+$/, '')}.webp`,
      alt: object.Metadata?.alt ?? null,
    })
    console.log(`  ← ${key} → originals/${year}/${name}`)
  }

  await writeFile(QUEUE, JSON.stringify(queue, null, 2) + '\n')
  console.log(`\n✓ ${queue.length} photo(s) ready for images:sync`)
}

// --- finish ------------------------------------------------------------------

async function finishPending() {
  if (!existsSync(QUEUE)) {
    console.log('· no queue file — nothing to finish')
    return
  }
  const queue = JSON.parse(await readFile(QUEUE, 'utf8'))
  if (!queue.length) {
    console.log('· queue is empty')
    await unlink(QUEUE)
    return
  }

  // Alt text is the one thing sync can't know: it comes from the Shortcut, and
  // sync has already written its `Photograph — <year>` default.
  const photos = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const bySrc = new Map(photos.map((photo) => [photo.src, photo]))
  let captioned = 0
  let missing = 0
  for (const item of queue) {
    const photo = bySrc.get(item.src)
    if (!photo) {
      // The sync didn't produce a rendition for it — a corrupt upload, most
      // likely. Say so and leave the original in incoming/ to be looked at.
      console.warn(`  ! ${item.key}: no manifest entry for ${item.src} — left in incoming/`)
      missing++
      continue
    }
    if (item.alt) {
      photo.alt = item.alt
      captioned++
    }
  }
  if (captioned) await writeFile(MANIFEST, JSON.stringify(photos, null, 2) + '\n')

  // Only now move the originals out of the queue: an upload is done when the
  // site knows about it, not when the file was copied.
  let archived = 0
  for (const item of queue) {
    if (!bySrc.has(item.src)) continue
    await s3.send(
      new CopyObjectCommand({
        Bucket: R2_ORIGINALS_BUCKET,
        CopySource: `${R2_ORIGINALS_BUCKET}/${item.key}`,
        Key: `${ARCHIVE}${item.year}/${item.name}`,
      }),
    )
    await s3.send(new DeleteObjectCommand({ Bucket: R2_ORIGINALS_BUCKET, Key: item.key }))
    archived++
  }

  await unlink(QUEUE)
  console.log(
    `✓ ${archived} original(s) archived to ${ARCHIVE}, ${captioned} alt text(s) applied` +
      (missing ? `, ${missing} left in ${INCOMING}` : ''),
  )
}

await (FETCH ? fetchPending() : finishPending())
