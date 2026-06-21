# [cailinpitt.com](https://cailinpitt.com)

Personal site + photography + blog. React (Vite + [`vite-react-ssg`](https://github.com/Daydreamer-riri/vite-react-ssg)),
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
  are **never committed** (see below). After adding images, push them to R2: `npm run images:upload`.
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
   then `npm run images:upload` (needs R2 creds in `.env`).
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
2. Add the image list to `src/lib/gallery-images.json` under a `"2026"` key:
   ```json
   "2026": [
     { "src": "/images/2026/sunset.jpg", "alt": "Sunset over the river", "width": 4000, "height": 3000 }
   ]
   ```
   `width`/`height` are optional but recommended (prevents layout shift). On macOS you can generate
   the entries from the folder with the built-in `sips`:
   ```bash
   for f in public/images/2026/*; do
     w=$(sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2}')
     h=$(sips -g pixelHeight "$f" | awk '/pixelHeight/{print $2}')
     printf '{ "src": "/images/2026/%s", "alt": "", "width": %s, "height": %s },\n' "$(basename "$f")" "$w" "$h"
   done
   ```
3. Register the gallery in `src/lib/galleries.ts` (keep it newest-first):
   ```ts
   { path: '/2026', title: '2026', images: images['2026'] },
   ```
   The `/2026` route and the `/photos` index update automatically.
4. Upload the photos to R2 (walks `public/images/`, pushes any new files; needs R2 creds in `.env`):
   ```bash
   npm run images:upload
   ```
5. Commit the **code** changes (`gallery-images.json`, `galleries.ts`) — never the photos — and push.

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


## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to
GitHub Pages. In the repo: **Settings → Pages → Source = GitHub Actions**. The custom domain is
set via `public/CNAME`.
