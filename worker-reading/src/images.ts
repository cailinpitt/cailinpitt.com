// Mirror remote images (book covers, article social cards) into the site's own
// R2 bucket, so /reading serves them from images.cailinpitt.com like everything
// else — no hotlinking publishers' CDNs, no broken art when a site reorganizes,
// and no third-party host seeing every visitor.
//
// Keys are content-addressed *by source url*, so a re-sync never needs to
// re-upload and a changed remote image lands on a new key rather than being
// replaced at the old one. That is the same cache-busting reasoning as the
// gallery renditions: objects go up `immutable`, so the bytes at a given key
// must never change.
//
// ## Subrequest budget
//
// On the Workers **free plan** an invocation gets 50 subrequests, and R2/KV/D1
// binding calls count toward it alongside `fetch()`. So this deliberately makes
// exactly **two** subrequests per image (one fetch, one put) and never calls
// `head()` to test for an existing key — callers avoid redundant work instead by
// tracking what they have already mirrored (see MIRROR_BUDGET in sync.ts).
// Re-putting an identical key is harmless: the key is a hash of the source url,
// so the bytes are the same.
//
// There is no `sharp` in Workers, so images are stored at their original size.
// The page uses fixed aspect-ratio boxes with object-fit, which prevents layout
// shift without needing to know each image's dimensions.

import { sha256Hex } from './hash'

const PREFIX = 'images/reading/'

/** Matches scripts/upload-r2.mjs, and is why keys must be content-addressed. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** Refuse anything larger than this. og:images and covers are far below it. */
const MAX_BYTES = 5 * 1024 * 1024

/** Give up on a slow origin rather than hold the invocation open. */
const TIMEOUT_MS = 10_000

/** Subrequests spent per successful mirror — one fetch, one R2 put. */
export const SUBREQUESTS_PER_IMAGE = 2

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

/** Key length. 12 hex chars is 48 bits — ample for a few thousand images. */
const KEY_HASH_LENGTH = 12

/**
 * Copy `source` into R2.
 *
 * Returns the root-relative `/images/reading/…` path to store in D1 (the site's
 * `imageUrl()` rewrites it to the R2 domain at render time), or null if the
 * image could not be mirrored. Callers must treat null as non-fatal: an entry
 * with no art still belongs in the log.
 */
export async function mirrorImage(env: Env, source: string | null): Promise<string | null> {
  if (!source) return null

  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  try {
    const res = await fetch(url.toString(), {
      headers: {
        accept: 'image/*',
        'user-agent': 'cailinpitt.com-reading/1.0 (+https://cailinpitt.com)',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null

    // SVG is deliberately absent from EXTENSIONS: it is active content, and
    // these are served from the same origin as the photo galleries.
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const ext = EXTENSIONS[contentType]
    if (!ext) return null

    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null

    // Buffer rather than stream: content-length is advisory, and reading the
    // body is the only way to actually enforce the cap.
    const body = await res.arrayBuffer()
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return null

    const key = `${PREFIX}${await sha256Hex(source, KEY_HASH_LENGTH)}.${ext}`
    await env.IMAGES.put(key, body, {
      httpMetadata: { contentType, cacheControl: CACHE_CONTROL },
    })
    return `/${key}`
  } catch (err) {
    console.error(`mirrorImage failed for ${source}:`, err)
    return null
  }
}
