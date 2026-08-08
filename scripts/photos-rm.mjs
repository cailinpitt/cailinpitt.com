#!/usr/bin/env node
// Take a photo off the site — every trace of it, in one command.
//
//   npm run photos:rm -- <id> [<id> ...]      # delete
//   npm run photos:rm -- <id> --dry-run       # show what would go, touch nothing
//   npm run photos:rm -- https://cailinpitt.com/photos/2026-img-1919
//
// An id is what's in the URL: /photos/2026-img-1919 → `2026-img-1919`. A whole
// URL works too, so you can paste straight from the address bar.
//
// Five things belong to a photo, and leaving any of them behind is its own kind
// of broken, which is why this is one command and not five:
//
//   1. its entry in src/lib/photos.json          (the feed and its page)
//   2. the renditions in images/<year>/   (local working copies)
//   3. the same renditions in R2                 (what the site actually serves)
//   4. the original in originals/<year>/         (local camera file)
//   5. the archived original in the private R2 bucket, if it was sent from the phone
//
// **The original goes too, and that is not optional.** `npm run images:sync`
// rebuilds renditions from whatever is in `originals/`, so a delete that spared
// the original would quietly republish the photo — under the same id, since ids
// are derived from the filename — the next time anything synced. If you want to
// keep the file, move it somewhere outside the repo *first*, then run this.
//
// Deleting is immediate and permanent, like `npm run guestbook:rm`. There is no
// trash. Use --dry-run if you want to look before you leap.
//
// R2 credentials come from .env, the same ones images:upload uses. Without
// R2_ORIGINALS_BUCKET the archived original is skipped with a warning rather
// than failing the delete.

import { readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { photoFiles } from './photo-manifest.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
import { localImagePath } from './paths.mjs'
const ORIGINALS_DIR = path.join(ROOT, 'originals')
const MANIFEST = path.join(ROOT, 'src', 'lib', 'photos.json')

try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* fall back to the ambient environment */
}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ORIGINALS_BUCKET } =
  process.env

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')

/** `2026-img-1919`, `/photos/2026-img-1919`, or the full URL — all mean the same photo. */
const toId = (arg) => arg.replace(/\/+$/, '').split('/').pop()

const ids = args.filter((arg) => !arg.startsWith('--')).map(toId)

if (!ids.length) {
  console.error('✗ Usage: npm run photos:rm -- <id> [<id> ...]   (add --dry-run to preview)')
  process.exit(1)
}

const dim = (s) => `\x1b[38;5;244m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

// ---- what belongs to each photo ---------------------------------------------

/** The original on disk for a photo, whatever extension it came in as. */
async function findOriginal(folder, stem) {
  const dir = path.join(ORIGINALS_DIR, folder)
  if (!existsSync(dir)) return null
  const match = (await readdir(dir)).find((name) => name.replace(/\.[^.]+$/, '') === stem)
  return match ? path.join(dir, match) : null
}

/**
 * The archived original in the private bucket, if this photo came from the phone.
 *
 * Never fatal. Only phone uploads have one at all, and an R2 token scoped to the
 * public bucket can't see this one — neither case is a reason to refuse to take
 * a photo off the site, so both degrade to a warning and an empty list.
 */
async function findArchived(s3, folder, stem) {
  if (!R2_ORIGINALS_BUCKET) return []
  try {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_ORIGINALS_BUCKET,
        Prefix: `originals/${folder}/${stem}`,
      }),
    )
    return (page.Contents ?? [])
      .map((object) => object.Key)
      .filter((key) => key.replace(/\.[^.]+$/, '') === `originals/${folder}/${stem}`)
  } catch (err) {
    console.warn(
      dim(`  ! could not check ${R2_ORIGINALS_BUCKET} for an archived original (${err.name})`),
    )
    return []
  }
}

// ---- main --------------------------------------------------------------------

async function main() {
  const photos = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const byId = new Map(photos.map((photo) => [photo.id, photo]))

  const targets = []
  let missing = 0
  for (const id of ids) {
    const photo = byId.get(id)
    if (!photo) {
      console.error(`✗ no photo with id ${bold(id)}`)
      missing++
      continue
    }
    targets.push(photo)
  }
  if (!targets.length) process.exit(missing ? 1 : 0)

  const needsR2 = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET
  if (!needsR2) {
    console.error('✗ Missing R2 credentials in .env — see the header of scripts/upload-r2.mjs.')
    process.exit(1)
  }
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  })
  if (!R2_ORIGINALS_BUCKET) {
    console.warn(
      dim('  ! R2_ORIGINALS_BUCKET not set — an archived original (if any) is left in place'),
    )
  }

  // Gather everything first, so --dry-run can show the whole picture and a real
  // run can't stop halfway through one photo.
  const plans = []
  for (const photo of targets) {
    const { folder, stem, renditions } = photoFiles(photo)
    plans.push({
      photo,
      renditions,
      localFiles: renditions
        .map((src) => localImagePath(src))
        .filter((file) => existsSync(file)),
      original: await findOriginal(folder, stem),
      archived: await findArchived(s3, folder, stem),
    })
  }

  for (const plan of plans) {
    console.log(`\n${bold(plan.photo.id)}  ${dim(plan.photo.alt)}`)
    for (const src of plan.renditions) console.log(`  r2      ${src.replace(/^\//, '')}`)
    for (const file of plan.localFiles) console.log(`  local   ${path.relative(ROOT, file)}`)
    if (plan.original) console.log(`  local   ${path.relative(ROOT, plan.original)}  (original)`)
    for (const key of plan.archived) console.log(`  r2      ${key}  (archived original)`)
    if (!plan.original && !plan.archived.length) {
      console.log(dim('  · no original found — nothing would resurrect this on the next sync'))
    }
  }

  if (DRY_RUN) {
    console.log(`\n${dim(`(dry run: ${plans.length} photo(s) would be deleted, nothing written)`)}`)
    return
  }

  // Manifest first: it is the only one of these that decides what the site
  // shows, so if a later step fails the photo is already gone from the feed
  // rather than half-deleted and still published.
  const removing = new Set(plans.map((plan) => plan.photo.id))
  await writeFile(
    MANIFEST,
    JSON.stringify(
      photos.filter((photo) => !removing.has(photo.id)),
      null,
      2,
    ) + '\n',
  )

  const publicKeys = plans.flatMap((plan) => plan.renditions.map((src) => src.replace(/^\//, '')))
  if (publicKeys.length) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: publicKeys.map((Key) => ({ Key })), Quiet: true },
      }),
    )
  }

  const archivedKeys = plans.flatMap((plan) => plan.archived)
  if (archivedKeys.length && R2_ORIGINALS_BUCKET) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: R2_ORIGINALS_BUCKET,
        Delete: { Objects: archivedKeys.map((Key) => ({ Key })), Quiet: true },
      }),
    )
  }

  let localCount = 0
  for (const plan of plans) {
    for (const file of plan.localFiles) {
      await unlink(file)
      localCount++
    }
    if (plan.original) {
      await unlink(plan.original)
      localCount++
    }
  }

  console.log(
    `\n✓ removed ${plans.length} photo(s): ${publicKeys.length + archivedKeys.length} R2 object(s), ` +
      `${localCount} local file(s), and their manifest entries`,
  )
  console.log(dim('  commit src/lib/photos.json and push to publish the removal'))
  // Same caveat as images:prune — uploads are immutable, so the edge holds them.
  console.log(dim("  the deleted images can serve from Cloudflare's edge cache for a while"))
  if (missing) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
