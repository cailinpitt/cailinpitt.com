#!/usr/bin/env node
// Upload the gallery photos to Cloudflare R2, mirroring the manifest's paths so the
// served URLs map 1:1 (manifest src "/images/2022/x.jpg" -> R2 key "images/2022/x.jpg").
//
// Idempotent: objects already present are skipped (pass FORCE=1 to re-upload all).
//
// Required env (an R2 API token gives you the access key id + secret):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=cailinpitt-photos \
//     node scripts/upload-r2.mjs

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')

// Load credentials from the local .env (gitignored) if present.
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* no .env — fall back to whatever is already in the environment */
}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env
const FORCE = process.env.FORCE === '1'
const CONCURRENCY = 8

for (const [k, v] of Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET })) {
  if (!v) {
    console.error(`✗ Missing env var ${k}. See the header of this script.`)
    process.exit(1)
  }
}

const CONTENT_TYPE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function uploadOne(src) {
  const key = src.replace(/^\//, '') // "/images/2022/x.jpg" -> "images/2022/x.jpg"
  const file = path.join(PUBLIC, key)
  if (!existsSync(file)) return { key, status: 'missing-local' }
  if (!FORCE && (await exists(key))) return { key, status: 'skip' }
  const body = await readFile(file)
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: CONTENT_TYPE[path.extname(file).toLowerCase()] || 'application/octet-stream',
      CacheControl: CACHE_CONTROL,
    }),
  )
  return { key, status: 'uploaded' }
}

async function mapLimit(items, limit, fn) {
  let next = 0
  const results = []
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// All files under public/images, as root-relative srcs (/images/<...>).
async function allImageSrcs(dir = path.join(PUBLIC, 'images')) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await allImageSrcs(p)))
    else out.push('/' + path.relative(PUBLIC, p).split(path.sep).join('/'))
  }
  return out
}

async function main() {
  // Every image (blog + galleries) lives under public/images and is served from R2.
  const srcs = await allImageSrcs()
  console.log(`Uploading ${srcs.length} images to r2://${R2_BUCKET}${FORCE ? ' (force)' : ''}…`)

  const results = await mapLimit(srcs, CONCURRENCY, uploadOne)
  const counts = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {})
  console.log('✓ done:', counts)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
