// Photo intake for cailinpitt.com/photos.
//
// One endpoint, `POST /ingest`: an iOS Shortcut hands it a photograph, and a
// couple of minutes later that photograph is live on the site with a page of
// its own. What happens in between is deliberately *not* here.
//
//   Shortcut → this Worker → R2 (originals bucket) → GitHub repository_dispatch
//            → .github/workflows/ingest-photos.yml → commit → deploy
//
// ## Why so little happens in the Worker
//
// The site is statically prerendered: a photo is a row in src/lib/photos.json,
// a pair of WebP renditions in R2, and a prerendered page. Producing the
// renditions and reading the EXIF needs `sharp`, which cannot run in a Worker —
// and the manifest is a file in git, which a Worker has no business writing.
//
// So this stores the original and rings a bell. The build, which already has
// sharp and a checkout, does the actual work (scripts/ingest-photos.mjs). The
// cost is that publishing takes a deploy rather than being instant; the payoff
// is that a phone upload is exactly the same kind of photo as one added from the
// laptop — prerendered, permalinked, with a social card — instead of a second
// class of photo that only exists at runtime.
//
// ## Why a second bucket
//
// Originals go to a private bucket, never `cailinpitt-photos`. That one is
// served publicly at images.cailinpitt.com, and an original carries EXIF the
// site deliberately never publishes — full-precision GPS above all (the site
// rounds to ~0.7 miles; see scripts/exif.mjs). A private bucket is what keeps
// "we uploaded the file" from meaning "we published the file".

/**
 * Constant-time string compare, so the token can't be recovered by timing
 * /ingest. Length is allowed to leak; the contents are not.
 */
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

/**
 * `/ingest` is callable from any origin — it's reached from a share sheet, not
 * from a page, so there is no origin to allowlist. The bearer token is the
 * security boundary.
 */
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

/** Where a browser landing on this Worker gets sent. */
const SITE_PHOTOS = 'https://cailinpitt.com/photos'

/**
 * What the build can turn into a photo. HEIC is deliberately absent: the
 * `sharp` build on a stock GitHub runner has no HEIF support, so a HEIC would
 * upload happily and then fail hours of debugging later. The Shortcut converts
 * to JPEG before posting (with metadata preserved) — see the README.
 */
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

/**
 * Read a form field that should be text, tolerating a single-element list.
 *
 * Shortcuts serializes several of its outputs as lists, so a field built from
 * one arrives as `["…"]` rather than a bare string. The reading Worker learned
 * this the hard way; coercing here is cheaper than asking the Shortcut to add a
 * "Get Item from List" step nobody would think to look for.
 */
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

/**
 * The wall clock to name the photo after, as `[YYYY, MM, DD, HH, MM, SS]`.
 *
 * Whatever the Shortcut reported as the photo's creation date, read as *written*
 * — the leading `YYYY-MM-DDTHH:MM:SS` is taken digit for digit and any zone
 * suffix ignored. Converting to UTC would file an evening photo under the next
 * day, and this is the same rule the rest of the site follows for capture times
 * (see the note in scripts/exif.mjs). Anything unparseable falls back to now.
 */
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

/**
 * The photo's filename, and with it its permanent URL.
 *
 * `MMDD-HHMMSS-xxxx` under a year folder, so the build files it as
 * `originals/2026/0802-154233-9f3c.jpg` and the site publishes it at
 * `/photos/2026-0802-154233-9f3c` — the id scheme in scripts/photo-manifest.mjs
 * is `<year>-<filename>`, which is what lets this Worker hand the Shortcut the
 * finished URL immediately, before the build that creates it has even started.
 *
 * The four random hex characters are there because two photos taken in the same
 * second is not impossible (a burst, a re-upload), and an id is a URL: a
 * collision would overwrite a page rather than add one.
 */
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

/**
 * `alt` and `taken` from wherever the caller found it easiest to put them: a
 * query parameter, or an `X-Photo-Alt` / `X-Photo-Taken` header.
 *
 * The header form exists for Shortcuts. Its *Get Contents of URL* action has a
 * Headers table right there — the one the bearer token already goes in — while
 * putting a variable into a query string means hand-building the URL and
 * worrying about escaping. Two more rows in a table you're already filling in is
 * a much better ask.
 */
const detail = (name: string, request: Request, url: URL): string | null =>
  asText(url.searchParams.get(name)) ?? asText(request.headers.get(`x-photo-${name}`))

/**
 * Pull the photo out of the request, accepting the two shapes a Shortcut can
 * produce.
 *
 * **Form** — `multipart/form-data` with `photo`, `alt`, `taken` fields. The
 * tidy one, and what the README recommends.
 *
 * **File** — the image as the raw body, with `alt` and `taken` given as headers
 * or query parameters. This exists because Shortcuts' "Get Contents of URL"
 * quietly switches its Request Body to *File* when you hand it an image, and the
 * resulting request is perfectly reasonable — it just isn't multipart. Rejecting
 * it taught nothing except that the endpoint was fussy.
 */
async function readUpload(request: Request, url: URL): Promise<Upload | Response> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()

  if (contentType.startsWith('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return json({ error: 'multipart body could not be parsed' }, 400)
    }
    // `FormData.get` is typed as returning `string | null` by
    // @cloudflare/workers-types, which is lossy: a file part comes back as a
    // File at runtime. Widening to `unknown` is what lets this check be the real one.
    const photo: unknown = form.get('photo')
    if (!(photo instanceof File)) {
      return json({ error: 'multipart body has no `photo` file' }, 400)
    }
    return {
      body: photo,
      type: photo.type,
      size: photo.size,
      // A form field wins, but the header/query forms still work alongside one —
      // so a Shortcut that switches its body shape doesn't have to be rebuilt.
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

  // Naming what arrived is the whole point of this message: "expected
  // multipart" on its own sends you looking at the wrong end of the Shortcut.
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
  // `taken` decides only the folder — i.e. the id, and where the original is
  // filed. The date the site shows is read from the file's own EXIF during the
  // build, which is authoritative and needs nothing from here; so a missing or
  // unparseable value falls back to now rather than failing the upload.
  const { year, stem } = mintName(upload.taken)
  const extension = upload.type === 'image/png' ? 'png' : 'jpg'
  const key = `incoming/${year}/${stem}.${extension}`
  const id = `${year}-${stem}`

  await env.ORIGINALS.put(key, upload.body.stream(), {
    httpMetadata: { contentType: upload.type },
    // Carried alongside the bytes rather than in a database: the build reads
    // both back together, and there is no other consumer to keep in sync.
    customMetadata: { ...(alt ? { alt } : {}), uploadedAt: new Date().toISOString() },
  })

  const dispatched = await dispatchBuild(env)

  return json({
    id,
    url: `${SITE_PHOTOS}/${id}`,
    // False means the photo is safely stored but no build was started — it will
    // be picked up by the next run (the workflow also runs on a schedule). Worth
    // surfacing so the Shortcut can say "saved, publishing later" honestly.
    building: dispatched,
  })
}

/**
 * Ask GitHub to run the ingest workflow.
 *
 * A failure here is deliberately not a failed upload: the original is already in
 * R2, and the workflow's own schedule will find it. Returning the outcome lets
 * the caller be told which of the two happened.
 */
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
