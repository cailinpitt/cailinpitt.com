#!/usr/bin/env node
// Bring the camera originals archived by the phone-upload pipeline back down to
// this machine.
//
//   npm run photos:pull            # download anything missing from originals/
//   npm run photos:pull -- --dry-run
//
// A photo added from the laptop already has its original in originals/. A photo
// sent from the phone does not — worker-photos put it straight into R2 and the
// build archived it there. This closes that gap, so the machine that holds the
// archive stays complete and `--reexif` keeps working on everything.
//
// Only downloads what's missing; existing files are never overwritten, so a local
// edit can't be clobbered by a re-run.
//
// Required env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ORIGINALS_BUCKET

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ORIGINALS_DIR = path.join(ROOT, 'originals')

/** Where scripts/ingest-photos.mjs files an original once it's published. */
const ARCHIVE = 'originals/'

try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* no .env — fall back to whatever is already in the environment */
}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ORIGINALS_BUCKET } = process.env
const DRY_RUN = process.argv.includes('--dry-run')

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

async function main() {
  const keys = []
  let ContinuationToken
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_ORIGINALS_BUCKET,
        Prefix: ARCHIVE,
        ContinuationToken,
      }),
    )
    for (const object of page.Contents ?? []) if (!object.Key.endsWith('/')) keys.push(object.Key)
    ContinuationToken = page.NextContinuationToken
  } while (ContinuationToken)

  const missing = keys.filter((key) => !existsSync(path.join(ROOT, key)))
  console.log(`${keys.length} archived original(s), ${missing.length} not here yet`)

  if (DRY_RUN) {
    for (const key of missing) console.log(`  ${key}`)
    console.log('(--dry-run: nothing downloaded)')
    return
  }

  for (const key of missing) {
    const object = await s3.send(new GetObjectCommand({ Bucket: R2_ORIGINALS_BUCKET, Key: key }))
    // The archive prefix is literally `originals/`, so a key maps onto the local
    // directory as-is.
    const file = path.join(ROOT, key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, Buffer.from(await object.Body.transformToByteArray()))
    console.log(`  ← ${key}`)
  }
  if (missing.length) console.log(`\n✓ ${missing.length} original(s) downloaded to ${ORIGINALS_DIR}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
