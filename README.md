# [cailinpitt.com](https://cailinpitt.com)

Personal site + photography + software projects + blog. React (Vite + [`vite-react-ssg`](https://github.com/Daydreamer-riri/vite-react-ssg)),
statically prerendered, deployed to GitHub Pages.

## Develop

```bash
npm install
npm run dev        # local dev server
npm run typecheck  # tsc --noEmit
npm run build      # static prerender → dist/ (also writes sitemap.xml, llms.txt)
npm run preview    # serve the built dist/
```

## Content

### Add a blog post

Create `content/blog/<slug>.md` with frontmatter. `path` is the **exact URL** (non-zero-padded
month/day, matching the old Squarespace convention) and must be unique:

```markdown
---
title: "Post title"
date: 2026-01-15
updated: 2026-02-03  # optional; only for a substantive revision
path: /blog/2026/1/15/post-slug
slug: post-slug
tags: ["music"]
description: "Optional summary for listings + social cards."
image: /images/post-slug/cover.jpg   # optional cover / social image
---

Markdown body…
```

- **Inline images**: drop the originals in `originals/<slug>/` and run `npm run images:publish` —
  each one is compressed to a 1600px WebP at `public/images/<slug>/<name>.webp` and pushed to R2.
  Reference that path in markdown as `/images/<slug>/<name>.webp` (note the extension changes).
  Those paths are rewritten to Cloudflare R2 at render time, so images are **never committed**
  (see below). `npm run images:sync` also reports any image a post references but that isn't on
  disk — suggesting the `.webp` name when that's the mismatch — plus files nothing references.
  Images already under `public/images/<slug>/` with no original are left alone.
- Markdown renders at build time (`react-markdown` + `remark-gfm`, with `rehype-raw` so embedded
  HTML like YouTube/Spotify iframes survives).
- **Tags** are free text. Each one becomes a chip under the post header and gets a prerendered
  `/blog/tag/<slug>` page, listed in the tag cloud at the foot of `/blog`. Pages are generated
  only for tags actually in use, so nothing needs registering — but note that a typo makes a new
  one-post tag. Grouping is by slug (`"Year in Review"` → `year-in-review`), so casing differences
  can't split a tag in two; the spelling shown is the one from the most recent post using it.
- **Social card image:** `image:` in frontmatter is optional — if omitted, the first image in the
  body is used as the `og:image`/`twitter:image` thumbnail (e.g. when sharing on Bluesky). Set
  `image:` explicitly only if you want a specific cover.
- **standard.site (Bluesky):** each post also gets an AT Protocol record so it renders as a
  first-class document in the Bluesky ecosystem. This is **not automatic** — you must run
  `npm run publish:atproto` and commit the updated `content/atproto.json` (see the checklist and
  the [standard.site](#standardsite--bluesky) section below).
- Otherwise posts are picked up automatically (glob of `content/blog/*.md`). The post shows up
  on `/blog`, the home "Recent writing", `sitemap.xml`, and `llms.txt`, gets JSON-LD, and is
  prerendered to a real HTML file at `path` (so old bookmarks keep working). No routing to wire.

#### Checklist for a new post

1. Create `content/blog/<slug>.md` with the frontmatter above.
2. Drop any inline images in `public/images/<slug>/`, reference them as `/images/<slug>/<file>`,
   then `npm run images:publish` (needs R2 creds in `.env`).
3. Preview locally: `npm run dev` (and optionally `npm run build` to sanity-check the prerender).
4. Publish the standard.site record: `npm run publish:atproto` (needs Bluesky creds in `.env`),
   then **commit the updated `content/atproto.json`**.
5. Commit the post (`content/blog/<slug>.md`) and push `main` → auto-deploys.
6. _Optional:_ re-share the post link on Bluesky — link cards are cached per-URL, so a fresh post
   forces Bluesky to re-fetch the new thumbnail/record.

### Add a photo gallery (e.g. 2026)

All images (blog + galleries) are served from Cloudflare R2 (`images.cailinpitt.com`) and **none
are committed** — all of `public/images/` is gitignored. Galleries are defined in
`src/lib/galleries.ts`; the image lists live in `src/lib/gallery-images.json`.

1. Put the full-size photos straight off the camera in `originals/2026/`.
2. ```bash
   npm run images:publish   # = images:sync + images:upload; needs R2 creds in .env
   ```
3. Commit the **code** changes (`gallery-images.json`, `galleries.ts`) — never the photos — and push.

That's it. `npm run images:sync` (`scripts/sync-images.mjs`) does the bookkeeping:

- **Compresses.** Every original under `originals/<folder>/` is encoded to WebP in
  `public/images/<folder>/`: a 2560px full size for the lightbox and a 1000px `-1000.webp`
  for the grid (quality 82, EXIF orientation baked in, EXIF metadata dropped). 2026 went from
  119 MB of camera files to 18 MB served, of which the grid only loads the 3 MB of thumbnails.
  Re-encoding is skipped when a rendition is newer than its original; `--reencode` forces it.
- **Registers new galleries.** A `public/images/<year>/` folder with no gallery yet is added to
  `galleryDefinitions` in `src/lib/galleries.ts`, in newest-first order. The `/2026` route and the
  `/photos` index follow automatically. Galleries with a title that isn't the folder name
  (`/latest-work` → "2017"), a `description`, or a `canonicalPath` alias stay hand-written — the
  script only ever *adds* the plain year ones.
- **Fills in the image list.** Each gallery's entries in `src/lib/gallery-images.json` are rebuilt
  from the folder — `src` (full size), `thumb` (grid) and `width`/`height` read from the file
  headers. Existing entries keep their order and any alt text you've written,
  so hand-tuning the running order or the alt of a photo survives re-runs; new files are appended
  in natural filename order with a default `Photograph — <title>` alt.
- **Records capture metadata.** Each entry also gets an `exif` object read from the *original*
  (the renditions are encoded with EXIF stripped): capture date, camera, aperture, shutter, ISO,
  focal length, and a coarse location. The lightbox shows it as a caption. Only galleries built
  from `originals/` have any — the pre-2026 photos came out of Squarespace already stripped, so
  they carry none and the caption just omits those lines. Like alt text, it's read once and then
  left alone, so a hand-edit sticks (useful when a camera reports a model code rather than a name
  — the drone identifies itself as `FC3170`). `--reexif` forces a re-read of every photo.
- **Never deletes silently.** A manifest entry whose file isn't on disk is kept and counted in the
  output (you may just not have that photo locally). Pass `--prune` to actually drop them.
- **Checks blog images** too — see [Add a blog post](#add-a-blog-post) above.

> **On location data.** `gallery-images.json` is committed and served to browsers, so anything
> in it is public and permanent. GPS coordinates are therefore rounded to 2 decimal places
> (~1.1 km) on the way in — enough to place a photo on a map or name a neighbourhood, not enough
> to point at an address. Full precision stays in the originals, which are gitignored and never
> uploaded. If you'd rather publish nothing at all, drop the `place` field in
> `scripts/exif.mjs` and re-run with `--reexif`; it will clear the recorded values.

`originals/` is gitignored and lives outside `public/`, so camera files are never committed,
never uploaded to R2, and never built into the site — only the renditions are. It is a local
working directory, **not a backup**: keep your originals wherever you normally keep them.

The older galleries (2014–2022, `/latest*`) predate this and have no originals — they're the
2500px JPEGs pulled from Squarespace, already web-sized, and sync leaves them exactly as they
are (no `thumb`, so the grid falls back to `src`). To bring one into the pipeline, move
`public/images/<key>/` to `originals/<key>/` and re-run; note that changes those images' URLs
and leaves the old objects orphaned in R2.

Useful variants:

```bash
npm run images:sync -- --prune     # drop manifest entries whose file is gone
npm run images:sync -- --reexif    # re-read capture metadata from the originals
npm run images:sync -- --reencode  # rebuild every rendition (e.g. after changing quality)
npm run images:check               # report only, no writes; exits non-zero if out of date
npm run images:upload -- --dry-run # show what would upload to R2, upload nothing
npm run images:prune               # list R2 objects nothing references (dry run)
npm run images:prune -- --delete   # …and delete them
```

`images:prune` is what cleans up after a gallery switches to new renditions: the superseded
objects stay in R2 otherwise. It compares the bucket against every `src`/`thumb` in the manifest
and every `/images/...` path in the blog markdown, and refuses to delete if anything referenced
is missing from the bucket (so a half-finished upload can't look like a bucket full of orphans).
Anything under `PROTECTED_PREFIXES` (currently `images/reading/`) is never touched — those objects
belong to the reading Worker and are referenced from its D1 database, which this script can't see.
Note that deleted objects can still serve from Cloudflare's edge cache for a while — the upload
sets `immutable` — so purge the URL in the dashboard if you need it gone immediately.

> The original galleries were pulled from the old Squarespace site with `npm run galleries:download`
> (Squarespace-specific). For new galleries, just drop files into `public/images/<gallery>/` as above.

### standard.site / Bluesky

Posts are published as [standard.site](https://standard.site) AT Protocol records so they render
as first-class long-form documents in the Bluesky ecosystem (not just a link card).
`scripts/publish-atproto.mjs` upserts one `site.standard.publication` record plus one
`site.standard.document` per post into your Bluesky repo (PDS). The build reads the resulting
AT-URIs from `content/atproto.json` to emit `/.well-known/site.standard.publication` and the
per-post `<link rel="site.standard.*">` tags — so the build itself needs **no** credentials.

Credentials live in `.env` (gitignored). Create an **app password** (not your real password) at
<https://bsky.app/settings/app-passwords>:

```
BLUESKY_IDENTIFIER=yourhandle.bsky.social   # handle or account email
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
# BLUESKY_PDS=https://bsky.social            # optional; default shown
```

```bash
npm run publish:atproto              # create/update records, rewrite content/atproto.json
npm run publish:atproto -- --dry-run # preview (lists posts; no login, no writes)
```

- **Idempotent:** records use stable record keys (`self` for the publication, the post slug per
  document), so re-running updates in place — it never creates duplicates.
- **Re-run whenever post content/metadata changes** (new post, edited title/description/body), then
  commit the updated `content/atproto.json`.
- The `did`/AT-URIs in `content/atproto.json` are public identifiers — safe to commit.


## Listening (`/listening`)

The `/listening` page shows what I'm playing now, 7d/30d stats, a year heatmap,
and a per-day scrobble log — sourced from Last.fm. The site stays static: a
standalone Cloudflare Worker (`worker/`) ingests scrobbles into a D1 archive on a
cron and serves a cached JSON bundle; the page fetches it in the browser.

- **Worker setup + how it stays free:** see [`worker/README.md`](worker/README.md).
- **Full-history backfill:** `node scripts/backfill-listening.mjs` (needs
  `LASTFM_API_KEY` in `.env`), then load the generated SQL into D1 (see worker README).
- **API base URL:** set `VITE_LISTENING_API` at build time (defaults to
  `https://listening.cailinpitt.com`).

## Reading (`/reading`)

The `/reading` page shows books (from [hardcover.app](https://hardcover.app)) and
articles, with cover art and social cards. Same shape as `/listening`: a standalone
Cloudflare Worker (`worker-reading/`) owns the data and the page fetches a JSON
bundle in the browser.

- **Books** are synced from Hardcover's GraphQL API on a daily cron into D1. The
  sync is a full replace, so the first run imports the entire history — there is no
  backfill script to run.
- **Articles** are pushed to an authenticated `POST /ingest` on the Worker, which
  fetches the page's `og:` metadata and social card and logs it. Saved from an
  iOS/macOS share-sheet Shortcut or a desktop bookmarklet — one tap from any app.
- **Images** (covers + social cards) are mirrored into the same R2 bucket as the
  photos, under `images/reading/`. Because those objects are referenced from D1
  rather than from the repo, `scripts/prune-r2.mjs` carries a `PROTECTED_PREFIXES`
  guard so `images:prune` can never delete them.
- **Setup, design notes, and how to test each piece separately:** see
  [`worker-reading/README.md`](worker-reading/README.md).
- **Check the Hardcover query without deploying:** `npm run reading:probe`
  (needs `HARDCOVER_TOKEN` in `.env`).
- **API base URL:** set `VITE_READING_API` at build time (defaults to
  `https://reading.cailinpitt.com`).

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to
GitHub Pages. In the repo: **Settings → Pages → Source = GitHub Actions**. The custom domain is
set via `public/CNAME`.
