# `worker-photos` — photo intake

The endpoint an iOS Shortcut posts a photograph to. A couple of minutes later
that photograph is live at `cailinpitt.com/photos`, with a page of its own.

```
Shortcut → POST /ingest → R2 (private originals bucket) → GitHub repository_dispatch
         → .github/workflows/ingest-photos.yml → commit → deploy
```

## What this Worker does, and what it deliberately doesn't

It authenticates the request, checks the file, stores it, and rings a bell. That
is all.

It does not resize, read EXIF, or write anything the site reads. It can't: the
renditions need `sharp`, which doesn't run in a Worker, and the photo manifest is
a file in git. Those belong to the build, which already has both — see
`scripts/ingest-photos.mjs`.

The consequence is worth stating plainly: **publishing takes a deploy, not a
second.** In exchange, a photo sent from the phone is the same kind of photo as
one added from the laptop — prerendered, permalinked, with a social card, in the
same `src/lib/photos.json` — rather than a second class of photo that only exists
at runtime. That was the whole reason for building it this way.

## Why the originals live in their own bucket

`cailinpitt-photo-originals` is **private**: no custom domain, no public access.
It is not `cailinpitt-photos`, which is served at `images.cailinpitt.com`.

An original carries the EXIF the site deliberately never publishes — full
precision GPS above all, which the site rounds to ~0.7 miles on the way in (see
`scripts/exif.mjs`). Putting originals in the public bucket would publish exactly
what that rounding exists to withhold, without anybody deciding to.

The build archives each original under `originals/<year>/` in the same private
bucket after publishing it, so the file survives the runner. Pull them back down
to your machine with `npm run photos:pull` from the repo root.

## Setup

```sh
npm install
wrangler r2 bucket create cailinpitt-photo-originals   # do NOT attach a domain
wrangler secret put INGEST_TOKEN     # any long random string; the Shortcut sends it
wrangler secret put GITHUB_TOKEN     # fine-grained PAT — Contents: read and write
npm run deploy
```

The repo also needs these GitHub Actions **secrets**, which
`.github/workflows/ingest-photos.yml` uses: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (the public one), and
`R2_ORIGINALS_BUCKET` (the private one).

## API

### `POST /ingest`

`multipart/form-data`, `Authorization: Bearer <INGEST_TOKEN>`.

| Field   | Required | Notes |
| ------- | -------- | ----- |
| `photo` | yes      | JPEG or PNG, up to 50 MB. |
| `alt`   | no       | Alt text / caption, up to 500 chars. Replaces the default `Photograph — <year>`. |
| `taken` | no       | The photo's creation date, e.g. `2026-08-02T15:42:33`. Decides the year folder and therefore the id — **not** the date the site shows, which is read from the file's own EXIF during the build. |

```json
{
  "id": "2026-0802-154233-9f3c",
  "url": "https://cailinpitt.com/photos/2026-0802-154233-9f3c",
  "building": true
}
```

The `url` is final the moment the upload succeeds, before the build that creates
it has started — the id scheme (`<year>-<filename>`, see
`scripts/photo-manifest.mjs`) is what makes that possible.

`building: false` means the photo is stored but no build was triggered: the
dispatch failed, or `GITHUB_TOKEN` isn't set. Nothing is lost — the workflow also
runs hourly and will find it.

Errors: `401` (bad or missing token), `400` (no file, empty file, or not
multipart), `415` (not JPEG/PNG), `413` (over 50 MB).

**HEIC is rejected on purpose.** `sharp` on a stock GitHub runner has no HEIF
support, so a HEIC would upload happily and fail an hour later in a place with no
obvious connection to the phone. The Shortcut converts to JPEG first.

## The Shortcut

Share sheet → Photos. Six actions:

1. **Receive** images from the share sheet.
2. **Convert Image** → JPEG, **Preserve Metadata: On**. This is the load-bearing
   toggle: with it off the photo arrives stripped and the site can only date it
   to the year, which is the exact problem the pre-2026 archive has.
3. **Get Details of Images** → *Creation Date* (for `taken`).
4. *(optional)* **Ask for Input** → Text, "Alt text?".
5. **Get Contents of URL**
   - URL: `https://photos.cailinpitt.com/ingest`
   - Method: `POST`
   - Headers: `Authorization` → `Bearer <INGEST_TOKEN>`
   - Request Body: **Form**
     - `photo` → the converted image (as a File)
     - `taken` → the creation date
     - `alt` → the text from step 4
6. **Show Notification** with `url` from the response.

## Testing without a phone

```sh
npm run dev                    # local, in-memory R2
npm run dev:remote             # the real bucket, so a build can actually see it

curl -X POST http://localhost:8787/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -F photo=@/path/to/photo.jpg \
  -F 'taken=2026-08-02T15:42:33' \
  -F 'alt=A test photograph'
```

For local runs put `INGEST_TOKEN` (and `GITHUB_TOKEN`, if you want the dispatch
to fire) in `worker-photos/.dev.vars`, which is gitignored.

Then, from the repo root, drive the other half by hand instead of waiting for the
dispatch:

```sh
node scripts/ingest-photos.mjs --fetch
npm run images:sync
npm run images:upload
node scripts/ingest-photos.mjs --finish
```
