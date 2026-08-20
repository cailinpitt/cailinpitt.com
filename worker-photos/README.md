# Photo intake (Cloudflare Worker)

Endpoint an iOS Shortcut posts a photo to. A few minutes later it's live at
`cailinpitt.com/photos`.

```
Shortcut → POST /ingest → R2 (private originals bucket) → GitHub repository_dispatch
         → .github/workflows/ingest-photos.yml → commit → deploy
```

## Scope

Authenticates the request, checks the file, stores it, and rings a bell — that's all.

No resizing, no EXIF reads, no writing anything the site reads. Renditions need `sharp` (doesn't
run in a Worker); the photo manifest is a file in git. Both belong to the build — see
`scripts/ingest-photos.mjs`.

Consequence: **publishing takes a deploy, not a second.** In exchange a phone photo is the same
kind of photo as one added from the laptop — prerendered, permalinked, with a social card, in the
same `src/lib/photos.json` — not a second-class runtime-only photo.

## Setup

```sh
npm install
wrangler r2 bucket create cailinpitt-photo-originals   # do NOT attach a domain
wrangler secret put INGEST_TOKEN     # any long random string; the Shortcut sends it
wrangler secret put GITHUB_TOKEN     # fine-grained PAT — Contents: read and write
npm run deploy
```

`.github/workflows/ingest-photos.yml` also needs GitHub Actions **secrets**: `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (public), `R2_ORIGINALS_BUCKET` (private).

### Why originals live in their own bucket

`cailinpitt-photo-originals` is **private** — no custom domain, no public access — unlike
`cailinpitt-photos`, served at `images.cailinpitt.com`.

An original carries EXIF the site never publishes, especially full-precision GPS (the site rounds
to ~0.7 miles on the way in, `scripts/exif.mjs`). Putting originals in the public bucket would
publish exactly what that rounding withholds.

The build archives each original under `originals/<year>/` in the private bucket after
publishing, so it survives the runner. Pull back with `npm run photos:pull` from the repo root.

## `POST /ingest`

`Authorization: Bearer <INGEST_TOKEN>`, and the photo in **either** of two shapes.

**Form** — `multipart/form-data`:

| Field | Required | Notes |
| --- | --- | --- |
| `photo` | yes | JPEG or PNG, up to 50 MB |
| `alt` | no | Alt text, up to 500 chars. Replaces the default `Photograph — <year>` |
| `taken` | no | Creation date, e.g. `2026-08-02T15:42:33`. Decides the year folder and the **id** — not the date shown on the site, which is read from EXIF at build |

**File** — the image as the raw request body with `Content-Type: image/jpeg`. `alt` and `taken`
then come from headers or query params:

```
X-Photo-Taken: 2026-08-02T15:42:33
X-Photo-Alt:   Golden hour

POST /ingest?taken=2026-08-02T15:42:33&alt=Golden%20hour     # or this
```

Both shapes are supported because Shortcuts' *Get Contents of URL* silently switches Request Body
to **File** once you hand it an image. Headers work with either shape and are easiest to set in
Shortcuts (same table as the bearer token). A `photo` form field wins over a same-named header.

```json
{
  "id": "2026-0802-154233-9f3c",
  "url": "https://cailinpitt.com/photos/2026-0802-154233-9f3c",
  "building": true
}
```

`url` is final the moment the upload succeeds, before the build starts — the Worker mints the
filename, and ids are `<year>-<filename>` (`scripts/photo-manifest.mjs`).

`building: false` means the photo is stored but no build was triggered (dispatch failed, or
`GITHUB_TOKEN` isn't set). Nothing is lost — the workflow also runs hourly.

Errors: `401` bad/missing token · `400` no file, empty file, or unreadable body (response names
the `content-type` it got) · `415` not JPEG/PNG · `413` over 50 MB.

**HEIC is rejected on purpose.** `sharp` on a stock GitHub runner has no HEIF support, so a HEIC
would upload fine and fail an hour later with no obvious link back to the phone. The Shortcut
converts to JPEG first.

## The Shortcut

Share sheet → Photos. Seven actions:

1. **Receive** images from the share sheet.
2. **Convert Image** → JPEG, **Preserve Metadata: On**. Load-bearing: off, and the photo arrives
   stripped, dateable only to the year.
3. **Get Details of Images** → *Creation Date*.
4. **Format Date** on that, **Custom** format `yyyy-MM-dd'T'HH:mm:ss`. Also load-bearing:
   Shortcuts otherwise formats by locale (`8/2/26, 3:42 PM`), which `/ingest` can't read — it
   falls back to upload time and may file the photo under the wrong year. Only the id/folder are
   affected, but the id is permanent.
5. *(optional)* **Ask for Input** → Text, "Alt text?".
6. **Get Contents of URL**
   - URL `https://photos.cailinpitt.com/ingest`, Method `POST`
   - Headers: `Authorization` → `Bearer <INGEST_TOKEN>`
   - Request Body **Form**: `photo` → the converted image, `taken` → step 4, `alt` → step 5

   **If Shortcuts switches the body to File, let it** — its default once an image is the input.
   Leave the body alone and move the two details into Headers: `X-Photo-Taken` → step 4,
   `X-Photo-Alt` → step 5. Those headers also work with the Form body, so the Shortcut keeps
   working whichever shape Shortcuts sends.
7. **Show Notification** with `url` from the response.

## Testing without a phone

```sh
npm run dev                    # local, in-memory R2
npm run dev:remote             # the real bucket, so a build can see it

# Form
curl -X POST http://localhost:8787/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -F photo=@/path/to/photo.jpg \
  -F 'taken=2026-08-02T15:42:33' \
  -F 'alt=A test photograph'

# File (what Shortcuts sends when it decides the body is an image)
curl -X POST http://localhost:8787/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H 'Content-Type: image/jpeg' \
  -H 'X-Photo-Taken: 2026-08-02T15:42:33' \
  -H 'X-Photo-Alt: A test photograph' \
  --data-binary @/path/to/photo.jpg
```

Local runs read `INGEST_TOKEN` (and `GITHUB_TOKEN`, for the dispatch to fire) from
`worker-photos/.dev.vars`, gitignored.

Drive the other half by hand from the repo root instead of waiting for the dispatch:

```sh
node scripts/ingest-photos.mjs --fetch
npm run images:sync
npm run images:upload
node scripts/ingest-photos.mjs --finish
```
