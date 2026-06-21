# [cailinpitt.com](https://cailinpitt.com)

Personal site + photography + blog. React (Vite + [`vite-react-ssg`](https://github.com/Daydreamer-riri/vite-react-ssg)),
statically prerendered, deployed to GitHub Pages.

## Develop

```bash
npm install
npm run dev        # local dev server
npm run typecheck  # tsc --noEmit
npm run build      # static prerender → dist/ (also writes sitemap.xml)
npm run preview    # serve the built dist/
```

## Content

Blog posts are Markdown files in `content/blog/`. Each one carries frontmatter, including the
**exact URL path** preserved from the old Squarespace site:

```markdown
---
title: "Post title"
date: 2023-03-03
path: /blog/2023/3/3/post-slug
slug: post-slug
tags: ["music"]
description: "Optional summary for listings + social cards."
---

Markdown body…
```

Markdown renders to HTML at build time (`react-markdown` + `remark-gfm`, with `rehype-raw` so
embedded HTML like YouTube/Spotify iframes survives). Each post becomes a real HTML file at its
`path`, so old bookmarks keep working.

Photo galleries live in `src/lib/galleries.ts` (one entry per preserved gallery URL).

## Migrating from Squarespace

1. **Export** from Squarespace: Settings → Import / Export → Export → **WordPress**. Save the
   `.xml` at the repo root as `squarespace-export.xml`.
2. **Convert posts → Markdown:**
   ```bash
   npm run migrate:posts
   ```
   Then review the generated files and delete `content/blog/example.md`.
3. **Pull images off the live CDN and rewrite links:**
   ```bash
   npm run migrate:images          # scans markdown + crawls live post URLs
   npm run migrate:images -- --no-crawl   # markdown-only
   ```
   Images land in `public/images/<slug>/`. The script reports total size and warns past ~1 GB.

Both inputs (`squarespace-export.xml`, `squarespace-backup/`) are gitignored.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to
GitHub Pages. In the repo: **Settings → Pages → Source = GitHub Actions**. The custom domain is
set via `public/CNAME`.
