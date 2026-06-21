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
- That's all — posts are picked up automatically (glob of `content/blog/*.md`). The post shows up
  on `/blog`, the home "Recent writing", `sitemap.xml`, and `llms.txt`, gets JSON-LD, and is
  prerendered to a real HTML file at `path` (so old bookmarks keep working). No routing to wire.

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


## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to
GitHub Pages. In the repo: **Settings → Pages → Source = GitHub Actions**. The custom domain is
set via `public/CNAME`.
