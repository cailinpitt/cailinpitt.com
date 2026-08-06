#!/usr/bin/env node
// Delete objects in R2 that nothing on the site references any more — e.g. the
// original-size files left behind when a gallery moves to compressed renditions.
//
//   npm run images:prune              # dry run: list what would go
//   npm run images:prune -- --delete  # actually delete
//   npm run images:prune -- --prefix images/2026/ --delete
//
// "Referenced" = every `src`/`thumb` in src/lib/photos.json plus every
// /images/... path in content/blog/*.md, plus anything under PROTECTED_PREFIXES.
// As a safety check it refuses to delete unless every referenced object is
// already present in the bucket (i.e. you've run `npm run images:upload` first) —
// otherwise a half-finished upload would look like a bucket full of orphans.

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* fall back to the ambient environment */
}

const args = process.argv.slice(2)
const DELETE = args.includes('--delete')
const prefixArg = args.indexOf('--prefix')
const PREFIX = prefixArg >= 0 ? args[prefixArg + 1] : 'images/'

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env
for (const [k, v] of Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET })) {
  if (!v) {
    console.error(`✗ Missing env var ${k}.`)
    process.exit(1)
  }
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

const asKey = (src) => src.replace(/^\//, '')
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * Key prefixes this script must never touch.
 *
 * Everything else it keeps is discovered by reading the repo, so an object is
 * "orphaned" precisely when nothing in the repo points at it. Worker-written
 * art is different: book covers and article social cards (worker-reading/) and
 * film posters (worker-watching/) are recorded in those Workers' D1 databases,
 * which are invisible from here. Without this guard every one of them would
 * look orphaned and a `--delete` run would wipe live images off /reading and
 * /watching.
 *
 * Any future Worker that writes into this bucket has to be added here too.
 */
const PROTECTED_PREFIXES = ['images/reading/', 'images/watching/']

const isProtected = (key) => PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix))

/** Every image key the built site can ask for. */
async function referencedKeys() {
  const keep = new Set()
  const photos = JSON.parse(await readFile(path.join(ROOT, 'src/lib/photos.json'), 'utf8'))
  for (const photo of photos) {
    for (const src of [photo.src, photo.thumb]) if (src) keep.add(asKey(src))
  }
  const blog = path.join(ROOT, 'content/blog')
  for (const file of (await readdir(blog)).filter((f) => f.endsWith('.md'))) {
    const body = await readFile(path.join(blog, file), 'utf8')
    for (const [, src] of body.matchAll(/(?:\]\(|["'(])(\/images\/[^\s)"']+)/g)) keep.add(asKey(src))
  }
  return keep
}

async function listBucket(prefix) {
  const objects = []
  let ContinuationToken
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken }),
    )
    objects.push(...(page.Contents ?? []))
    ContinuationToken = page.NextContinuationToken
  } while (ContinuationToken)
  return objects
}

async function main() {
  const keep = await referencedKeys()
  const remote = await listBucket(PREFIX)
  const present = new Set(remote.map((o) => o.Key))
  const orphans = remote.filter((o) => !keep.has(o.Key) && !isProtected(o.Key))
  const bytes = orphans.reduce((sum, o) => sum + o.Size, 0)
  const protectedCount = remote.filter((o) => isProtected(o.Key)).length

  console.log(
    `r2://${R2_BUCKET}/${PREFIX}: ${remote.length} object(s), ` +
      `${remote.length - orphans.length} referenced, ${orphans.length} orphaned (${mb(bytes)})`,
  )
  if (protectedCount) {
    console.log(
      `  (${protectedCount} of those are under ${PROTECTED_PREFIXES.join(', ')} — ` +
        `owned by the Workers, never pruned from here)`,
    )
  }
  if (!orphans.length) return
  for (const o of orphans.slice(0, 15)) console.log(`  ${o.Key}  ${mb(o.Size)}`)
  if (orphans.length > 15) console.log(`  …and ${orphans.length - 15} more`)

  if (!DELETE) {
    console.log('\n(dry run — pass --delete to remove these)')
    return
  }

  // Guard: never prune against a bucket that hasn't received the current renditions.
  const notUploaded = [...keep].filter((key) => key.startsWith(PREFIX) && !present.has(key))
  if (notUploaded.length) {
    console.error(
      `\n✗ ${notUploaded.length} referenced image(s) are not in the bucket yet — ` +
        `run \`npm run images:upload\` first. Nothing deleted.`,
    )
    for (const key of notUploaded.slice(0, 5)) console.error(`    ${key}`)
    process.exit(1)
  }

  // DeleteObjects takes at most 1000 keys per call.
  let deleted = 0
  for (let i = 0; i < orphans.length; i += 1000) {
    const batch = orphans.slice(i, i + 1000).map((o) => ({ Key: o.Key }))
    const res = await s3.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: batch } }))
    deleted += res.Deleted?.length ?? 0
    for (const err of res.Errors ?? []) console.error(`  ✗ ${err.Key}: ${err.Message}`)
  }
  console.log(`\n✓ deleted ${deleted} object(s), freed ${mb(bytes)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
