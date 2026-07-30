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

- **Inline images** go in `public/images/<slug>/` and are referenced in markdown as
  `/images/<slug>/<file>`. Those paths are rewritten to Cloudflare R2 at render time, so images
  are **never committed** (see below). After adding images, run `npm run images:publish` — it
  checks the references and pushes the files to R2. `npm run images:sync` on its own reports
  any image a post references but that isn't on disk (typo'd filename), plus any file in the
  folder no post uses.
- Markdown renders at build time (`react-markdown` + `remark-gfm`, with `rehype-raw` so embedded
  HTML like YouTube/Spotify iframes survives).
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

1. Put the full-size photos in `public/images/2026/` (all of `public/images/` is already gitignored).
2. ```bash
   npm run images:publish   # = images:sync + images:upload; needs R2 creds in .env
   ```
3. Commit the **code** changes (`gallery-images.json`, `galleries.ts`) — never the photos — and push.

That's it. `npm run images:sync` (`scripts/sync-images.mjs`) does the bookkeeping:

- **Registers new galleries.** A `public/images/<year>/` folder with no gallery yet is added to
  `galleryDefinitions` in `src/lib/galleries.ts`, in newest-first order. The `/2026` route and the
  `/photos` index follow automatically. Galleries with a title that isn't the folder name
  (`/latest-work` → "2017"), a `description`, or a `canonicalPath` alias stay hand-written — the
  script only ever *adds* the plain year ones.
- **Fills in the image list.** Each gallery's entries in `src/lib/gallery-images.json` are rebuilt
  from the folder, with `width`/`height` read from the file headers (no native dependency; JPEG,
  PNG, WebP, GIF and HEIC/AVIF). Existing entries keep their order and any alt text you've written,
  so hand-tuning the running order or the alt of a photo survives re-runs; new files are appended
  in natural filename order with a default `Photograph — <title>` alt.
- **Never deletes silently.** A manifest entry whose file isn't on disk is kept and counted in the
  output (you may just not have that photo locally). Pass `--prune` to actually drop them.
- **Checks blog images** too — see [Add a blog post](#add-a-blog-post) above.

Useful variants:

```bash
npm run images:sync -- --prune   # drop manifest entries whose file is gone
npm run images:check             # report only, no writes; exits non-zero if out of date
```

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

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to
GitHub Pages. In the repo: **Settings → Pages → Source = GitHub Actions**. The custom domain is
set via `public/CNAME`.
