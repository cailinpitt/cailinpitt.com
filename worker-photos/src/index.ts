// Photo intake for cailinpitt.com/photos. POST /ingest stores the upload in R2
// and fires a GitHub repository_dispatch to run ingest-photos.yml, which does
// the actual work (renditions + EXIF need `sharp`, which can't run in a
// Worker, and the manifest lives in git).
//
// Originals go to a private bucket, not the public images bucket — an original
// carries full-precision EXIF (GPS etc.) the site never publishes.

/** Constant-time compare, so /ingest's token can't be recovered by timing. */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function authorized(request: Request, secret: string | undefined): boolean {
  const header = request.headers.get('authorization') ?? ''
  const token = header.replace(/^Bearer\s+/i, '')
  return Boolean(secret) && Boolean(token) && secretEquals(token, secret as string)
}

// Callable from any origin — reached from a share sheet, not a page, so there's
// no origin to allowlist. The bearer token is the security boundary.
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

/** Where a browser landing on this Worker gets sent. */
const SITE_PHOTOS = 'https://cailinpitt.com/photos'

// HEIC deliberately excluded: the `sharp` build on a stock GitHub runner has no
// HEIF support. The Shortcut converts to JPEG before posting — see the README.
const ACCEPTED = new Set(['image/jpeg', 'image/png'])

/** Generous enough for a 100-megapixel raw-ish JPEG, small enough to bound abuse. */
const MAX_BYTES = 50 * 1024 * 1024

/** Cap on alt text, so a stray paste can't become the caption. */
const MAX_ALT = 500

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  })

// Shortcuts serializes some fields as single-element lists (`["…"]`); coerce
// rather than making the Shortcut add a "Get Item from List" step.
function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      const first = parsed.find((v) => typeof v === 'string' && v.trim())
      return typeof first === 'string' ? first.trim() : null
    }
  } catch {
    /* not JSON, which is the normal case */
  }
  return trimmed
}

const pad = (n: number) => String(n).padStart(2, '0')

// The wall clock to name the photo after, as `[YYYY, MM, DD, HH, MM, SS]`.
// Read as written (digits taken as-is, zone ignored) — converting to UTC could
// file an evening photo under the next day; same rule as scripts/exif.mjs.
// Falls back to now if unparseable.
function wallClock(value: string | null): string[] {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/)
  if (match) return match.slice(1)
  const now = new Date()
  return [
    String(now.getUTCFullYear()),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ]
}

// `MMDD-HHMMSS-xxxx` under a year folder, e.g. `originals/2026/0802-154233-9f3c.jpg`
// published at `/photos/2026-0802-154233-9f3c` (id scheme is `<year>-<filename>`,
// scripts/photo-manifest.mjs) — lets this Worker hand back the finished URL
// before the build even starts. Random hex guards against two photos in the
// same second colliding and overwriting a page.
function mintName(taken: string | null): { year: string; stem: string } {
  const [year, month, day, hour, minute, second] = wallClock(taken)
  const hex = [...crypto.getRandomValues(new Uint8Array(2))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return { year, stem: `${month}${day}-${hour}${minute}${second}-${hex}` }
}

/** One upload, however it was framed on the wire. */
interface Upload {
  body: Blob
  type: string
  size: number
  alt: string | null
  taken: string | null
}

// `alt`/`taken` from a query param or an `X-Photo-Alt`/`X-Photo-Taken` header.
// The header form exists for Shortcuts: its Headers table is where the bearer
// token already goes, easier than hand-building a query string.
const detail = (name: string, request: Request, url: URL): string | null =>
  asText(url.searchParams.get(name)) ?? asText(request.headers.get(`x-photo-${name}`))

// Accepts two shapes: multipart/form-data (the tidy one, README-recommended),
// or the image as a raw body with alt/taken as headers/query params — because
// Shortcuts' "Get Contents of URL" silently switches to a raw File body for
// images, and that request is perfectly valid, just not multipart.
async function readUpload(request: Request, url: URL): Promise<Upload | Response> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()

  if (contentType.startsWith('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return json({ error: 'multipart body could not be parsed' }, 400)
    }
    // workers-types mistypes FormData.get as string | null; a file part is
    // actually a File at runtime, so widen to unknown to check it properly.
    const photo: unknown = form.get('photo')
    if (!(photo instanceof File)) {
      return json({ error: 'multipart body has no `photo` file' }, 400)
    }
    return {
      body: photo,
      type: photo.type,
      size: photo.size,
      // Form field wins but falls back to header/query, so a Shortcut that
      // switches body shape doesn't need rebuilding.
      alt: asText(form.get('alt')) ?? detail('alt', request, url),
      taken: asText(form.get('taken')) ?? detail('taken', request, url),
    }
  }

  if (ACCEPTED.has(contentType.split(';')[0].trim())) {
    const body = await request.blob()
    return {
      body,
      type: contentType.split(';')[0].trim(),
      size: body.size,
      alt: detail('alt', request, url),
      taken: detail('taken', request, url),
    }
  }

  // Echo back what arrived — "expected multipart" alone sends you looking at
  // the wrong end of the Shortcut.
  return json(
    {
      error:
        'cannot read a photo from this request — send multipart/form-data with a `photo` ' +
        'field, or the image itself as the raw body',
      received: contentType || '(no content-type header)',
    },
    400,
  )
}

async function ingest(request: Request, url: URL, env: Env): Promise<Response> {
  if (!authorized(request, env.INGEST_TOKEN)) return json({ error: 'unauthorized' }, 401)

  const upload = await readUpload(request, url)
  if (upload instanceof Response) return upload

  if (!ACCEPTED.has(upload.type)) {
    return json({ error: `unsupported type ${upload.type || 'unknown'} — send JPEG or PNG` }, 415)
  }
  if (upload.size > MAX_BYTES) {
    return json({ error: `photo is ${upload.size} bytes, over the ${MAX_BYTES} limit` }, 413)
  }
  if (upload.size === 0) return json({ error: 'photo is empty' }, 400)

  const alt = upload.alt?.slice(0, MAX_ALT) ?? null
  // `taken` only decides the folder/id — the build reads EXIF for the real
  // date — so a missing or bad value falls back to now rather than failing.
  const { year, stem } = mintName(upload.taken)
  const extension = upload.type === 'image/png' ? 'png' : 'jpg'
  const key = `incoming/${year}/${stem}.${extension}`
  const id = `${year}-${stem}`

  await env.ORIGINALS.put(key, upload.body.stream(), {
    httpMetadata: { contentType: upload.type },
    // Carried alongside the bytes rather than in a database — the build reads
    // both together and nothing else needs to stay in sync.
    customMetadata: { ...(alt ? { alt } : {}), uploadedAt: new Date().toISOString() },
  })

  const dispatched = await dispatchBuild(env)

  return json({
    id,
    url: `${SITE_PHOTOS}/${id}`,
    // False = stored but no build triggered; the workflow's own schedule will
    // still pick it up. Lets the Shortcut say "saved, publishing later" honestly.
    building: dispatched,
  })
}

// Ask GitHub to run the ingest workflow. A failure here isn't a failed upload —
// the original is already in R2 and the workflow's schedule will find it.
async function dispatchBuild(env: Env): Promise<boolean> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return false
  try {
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        // GitHub rejects requests without one.
        'user-agent': 'cailinpitt-photos-worker',
      },
      body: JSON.stringify({ event_type: 'photo-uploaded' }),
    })
    return response.ok
  } catch {
    return false
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (url.pathname === '/ingest') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
      return ingest(request, url, env)
    }

    // Anything else is a person, not the Shortcut.
    return Response.redirect(SITE_PHOTOS, 302)
  },
} satisfies ExportedHandler<Env>
