// Mirror remote artwork (film posters from Letterboxd, show posters from TMDB)
// into the site's own R2 bucket, so /watching serves them from
// images.cailinpitt.com — no hotlinking, no broken art on a host reorg, no
// third party seeing visitors. Deliberate copy of worker-reading/src/images.ts
// with a different prefix — the packages share no module.
//
// Keys are content-addressed by source url (immutable, same as gallery
// renditions), so a re-sync never re-uploads. Free-plan Workers get 50
// subrequests per invocation, so this spends exactly 2 per image (fetch + put)
// and never calls head() — callers track what's already mirrored instead (see
// MIRROR_BUDGET in sync.ts).

import { sha256Hex } from './hash'

const PREFIX = 'images/watching/'

/** Matches scripts/upload-r2.mjs, and is why keys must be content-addressed. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** Refuse anything larger than this. Posters are far below it. */
const MAX_BYTES = 5 * 1024 * 1024

/** Give up on a slow origin rather than hold the invocation open. */
const TIMEOUT_MS = 10_000

/** Subrequests spent per successful mirror — one fetch, one R2 put. */
export const SUBREQUESTS_PER_IMAGE = 2

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

/** Key length. 12 hex chars is 48 bits — ample for a few thousand images. */
const KEY_HASH_LENGTH = 12

// Copy `source` into R2. Returns the root-relative /images/watching/… path to
// store in D1, or null if it couldn't be mirrored — non-fatal, an entry with
// no art still belongs in the log.
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
        'user-agent': 'cailinpitt.com-watching/1.0 (+https://cailinpitt.com)',
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
