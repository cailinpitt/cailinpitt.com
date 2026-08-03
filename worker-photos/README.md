# Photo intake (Cloudflare Worker)

The endpoint an iOS Shortcut posts a photograph to. A couple of minutes later it's live at
`cailinpitt.com/photos` with a page of its own.

```
Shortcut → POST /ingest → R2 (private originals bucket) → GitHub repository_dispatch
         → .github/workflows/ingest-photos.yml → commit → deploy
```

## Scope

This Worker authenticates the request, checks the file, stores it, and rings a bell. That's all.

It does not resize, read EXIF, or write anything the site reads — it can't. Renditions need
`sharp`, which doesn't run in a Worker, and the photo manifest is a file in git. Both belong to the
build; see `scripts/ingest-photos.mjs`.

The consequence: **publishing takes a deploy, not a second.** In exchange a phone photo is the same
kind of photo as one added from the laptop — prerendered, permalinked, with a social card, in the
same `src/lib/photos.json` — rather than a second class of photo that only exists at runtime.

## Setup

```sh
npm install
wrangler r2 bucket create cailinpitt-photo-originals   # do NOT attach a domain
wrangler secret put INGEST_TOKEN     # any long random string; the Shortcut sends it
wrangler secret put GITHUB_TOKEN     # fine-grained PAT — Contents: read and write
npm run deploy
```

`.github/workflows/ingest-photos.yml` also needs these GitHub Actions **secrets**:
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (public), and
`R2_ORIGINALS_BUCKET` (private).

### Why originals live in their own bucket

`cailinpitt-photo-originals` is **private**: no custom domain, no public access. It is not
`cailinpitt-photos`, which is served at `images.cailinpitt.com`.

An original carries the EXIF the site deliberately never publishes — full-precision GPS above all,
which the site rounds to ~0.7 miles on the way in (`scripts/exif.mjs`). Putting originals in the
public bucket would publish exactly what that rounding exists to withhold.

The build archives each original under `originals/<year>/` in the private bucket after publishing,
so the file survives the runner. Pull them back with `npm run photos:pull` from the repo root.

## `POST /ingest`

`Authorization: Bearer <INGEST_TOKEN>`, and the photo in **either** of two shapes.

**Form** — `multipart/form-data`:

| Field | Required | Notes |
| --- | --- | --- |
| `photo` | yes | JPEG or PNG, up to 50 MB |
| `alt` | no | Alt text, up to 500 chars. Replaces the default `Photograph — <year>` |
| `taken` | no | Creation date, e.g. `2026-08-02T15:42:33`. Decides the year folder and therefore the **id** — not the date the site shows, which is read from EXIF during the build |

**File** — the image as the raw request body with `Content-Type: image/jpeg`. `alt` and `taken`
then come from headers or query parameters:

```
X-Photo-Taken: 2026-08-02T15:42:33
X-Photo-Alt:   Golden hour

POST /ingest?taken=2026-08-02T15:42:33&alt=Golden%20hour     # or this
```

Both body shapes are supported because Shortcuts' *Get Contents of URL* quietly switches its
Request Body to **File** the moment you hand it an image. The headers work with *either* shape and
are the easiest thing to set in Shortcuts (same table as the bearer token). A `photo` form field
wins over a header of the same name.

```json
{
  "id": "2026-0802-154233-9f3c",
  "url": "https://cailinpitt.com/photos/2026-0802-154233-9f3c",
  "building": true
}
```

The `url` is final the moment the upload succeeds, before the build has started — the Worker mints
the filename and ids are `<year>-<filename>` (see `scripts/photo-manifest.mjs`).

`building: false` means the photo is stored but no build was triggered (the dispatch failed, or
`GITHUB_TOKEN` isn't set). Nothing is lost — the workflow also runs hourly.

Errors: `401` bad or missing token · `400` no file, empty file, or an unreadable body (the response
names the `content-type` it got) · `415` not JPEG/PNG · `413` over 50 MB.

**HEIC is rejected on purpose.** `sharp` on a stock GitHub runner has no HEIF support, so a HEIC
would upload happily and fail an hour later somewhere with no obvious connection to the phone. The
Shortcut converts to JPEG first.

## The Shortcut

Share sheet → Photos. Seven actions:

1. **Receive** images from the share sheet.
2. **Convert Image** → JPEG, **Preserve Metadata: On**. Load-bearing: with it off the photo arrives
   stripped and the site can only date it to the year.
3. **Get Details of Images** → *Creation Date*.
4. **Format Date** on that, **Custom** format `yyyy-MM-dd'T'HH:mm:ss`. Also load-bearing: Shortcuts
   otherwise formats dates by locale (`8/2/26, 3:42 PM`), which `/ingest` can't read, so it falls
   back to upload time and may file the photo under the wrong year. Only the id and folder are
   affected — but the id is permanent.
5. *(optional)* **Ask for Input** → Text, "Alt text?".
6. **Get Contents of URL**
   - URL `https://photos.cailinpitt.com/ingest`, Method `POST`
   - Headers: `Authorization` → `Bearer <INGEST_TOKEN>`
   - Request Body **Form**: `photo` → the converted image, `taken` → step 4, `alt` → step 5

   **If Shortcuts switches the body to File, let it** — that's its default once an image is the
   input. Leave the body alone and move the two details up into the Headers table:
   `X-Photo-Taken` → step 4, `X-Photo-Alt` → step 5. Those headers work with the Form body too, so
   a Shortcut built this way keeps working whichever shape Shortcuts sends.
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

Local runs read `INGEST_TOKEN` (and `GITHUB_TOKEN`, if you want the dispatch to fire) from
`worker-photos/.dev.vars`, which is gitignored.

Then drive the other half by hand from the repo root instead of waiting for the dispatch:

```sh
node scripts/ingest-photos.mjs --fetch
npm run images:sync
npm run images:upload
node scripts/ingest-photos.mjs --finish
```
