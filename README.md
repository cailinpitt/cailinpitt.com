# [cailinpitt.com](https://cailinpitt.com)

Personal site + photography + software projects + blog. React (Vite + [`vite-react-ssg`](https://github.com/Daydreamer-riri/vite-react-ssg)),
statically prerendered, deployed to GitHub Pages.

## Develop

```bash
npm install
npm run dev        # local dev server
npm run typecheck  # tsc --noEmit
npm test           # vitest run (see Tests below)
npm run build      # static prerender → dist/ (also writes sitemap.xml, llms.txt, feed.xml, og cards)
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
- **Social card:** every page gets its own card rendered at build time (see
  [Social cards](#social-cards)). For a post, `image:` in frontmatter picks the photograph that
  runs behind the title; if omitted, the first image in the body is used. A post with no images
  at all gets the paper card instead — nothing to set.
- **standard.site (Bluesky):** each post also gets an AT Protocol record so it renders as a
  first-class document in the Bluesky ecosystem. This is **not automatic** — you must run
  `npm run publish:atproto` and commit the updated `content/atproto.json` (see the checklist and
  the [standard.site](#standardsite--bluesky) section below).
- **Reading time** is counted at build time from the prose in the body — code, embedded HTML,
  image syntax, and link targets don't count, link text does. Posts under 100 words show no
  estimate at all, which is why the travel photo essays don't claim to be a "1 min read".
- **Related posts** — up to three posts sharing the most tags with this one, above the
  newer/older nav. A post with no tags gets none, rather than three arbitrary ones.
- **Headings** get an `id` (from `rehype-slug`) and a `#` self-link, so a section of a long
  post can be pointed at. The link is invisible until the heading is hovered or it takes
  focus, and `scripts/generate-rss.mjs` strips it back out of feed items — the ids stay.
- **`updated:`** is shown in the post's meta line ("Updated February 3, 2026") as well as in
  the JSON-LD `dateModified`. Set it only for a substantive revision: the date beside it is
  when the post was written, and most posts should carry just that one.
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
> (~0.7 miles) on the way in — enough to place a photo on a map or name a neighborhood, not enough
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
- **`/sparkline.json`** serves 90 daily counts for the homepage sparkline — a projection
  of the heatmap blob the cron already computes, so it costs one KV read and no D1. Today's
  bar inherits the heatmap's ~6h cadence and can read low against a day still in progress.
  **Requires deploying the Worker** (`cd worker && npx wrangler deploy`); until then it 404s
  and the sparkline simply doesn't render.

## Blog index (`/blog`)

The list is grouped into year sections, and rows inside a section show only the month and
day since the year is in the heading above them (the `datetime` attribute still carries the
whole date). A filter above the list narrows by title, summary, tag, or date — every
whitespace-separated term has to match, so "music 2019" narrows rather than widening.

Matching is a substring scan over a map built once from the posts already on the page:
~35 posts needs no search index, no dependency, and no fetch. With JavaScript off the input
goes inert and the full list is still there, because it's in the prerendered HTML.

## RSS feed (`/feed.xml`)

`scripts/generate-rss.mjs` writes a full-content RSS 2.0 feed as part of `postbuild`
(`npm run rss` re-runs it against an existing `dist/`). `index.html` carries the
`<link rel="alternate" type="application/rss+xml">` autodiscovery tag on every page, and
`/blog` links it under the post count.

- **Item bodies come from the prerendered HTML**, not from re-rendering the markdown here:
  the script lifts what's inside `<div class="post-body">` out of each post's built page.
  The build already turns markdown into HTML once — with GFM, raw HTML embeds, and the R2
  image rewriting — and a second renderer in this script would be one more thing to keep in
  sync, with the feed quietly drifting from the page when it fell behind. Metadata (title,
  date, tags, summary) still comes from the frontmatter.
- **Root-relative URLs are made absolute**, since a feed item is read somewhere that isn't
  this site. Post images are already absolute R2 URLs by the time they're rendered, so in
  practice this is links between posts.
- **The 20 most recent posts** carry full text (`MAX_ITEMS`); older ones stay at `/blog`. A
  feed is re-fetched on a timer forever, and readers only show a new subscriber the recent
  items anyway.
- **`lastBuildDate` is the newest post's date, not the build time** — every deploy rewrites
  this file, and a timestamp that moved when nothing was published would keep telling
  subscribers there's something new.

## Color theme

Light/dark follows `prefers-color-scheme`; the header toggle cycles System → Light → Dark,
stores the choice in `localStorage`, and applies it as `data-theme` on `<html>`. A tiny
inline script in `index.html` applies a stored choice before first paint.

`index.html` also ships two media-scoped `<meta name="theme-color">` tags — the browser
chrome matches the **page background**, not the accent, so the toolbar reads as an extension
of the paper. A media query can't see the manual override, so `ThemeToggle` rewrites both
tags with the resolved `--bg` when a theme is forced, and restores them for System. The
value is read from the stylesheet rather than repeated in JS, which is also why it happens
after mount: in the pre-paint script the CSS isn't loaded and `--bg` reads empty. The cost
is that an overridden theme keeps the media-matched tint for the first few frames — which
tints browser chrome and nothing on the page.

## Search (⌘K)

Every page carries a command palette — **⌘K** / **Ctrl-K**, or **/** when you aren't already
typing, or the magnifier in the header. It jumps to any page, post, gallery, or tag.

- **The index is compiled in, not fetched.** A small Vite plugin
  (`cailinpitt:site-index` in `vite.config.ts`) reads `content/blog/*.md` at build time and
  inlines the frontmatter — path, title, date, tags — as the `virtual:site-index` module.
  That's ~100 bytes per post and no request, where an eager `import.meta.glob` would have
  shipped every post's *body* to the browser and a generated JSON file would have cost a
  round trip before the palette could open. Bodies are never included; the plugin uses the
  same frontmatter parser as the site (`src/lib/frontmatter.ts`), so it can't disagree with
  the rendered pages about what a post is called.
- Adding a post needs nothing done here — it's in the palette on the next build. In dev the
  module is invalidated when anything under `content/blog/` changes.
- Pages are listed by hand in `PAGES` in `src/components/CommandPalette.tsx`; **a new route
  needs adding there** (galleries and tags are derived, so those don't). Forgetting is caught
  by `tests/command-palette.test.ts`, which holds the list against the routes in `App.tsx` in
  both directions — a page missing from the palette, and an entry pointing at a route that no
  longer exists. It can't guess a label or the words someone would search for, so it fails
  rather than deriving the list.
- It's a native `<dialog>` opened with `showModal()`, like the gallery lightbox — focus
  trapping and Escape come with it rather than being reimplemented.

## Homepage

Mostly static, with three things that change on their own:

- **🎧 Last played** — the now-playing bar (polls `/now.json` every 60s), a 90-day
  sparkline, and an "on this day" line drawn from `/on-this-day.json`, which the listening
  Worker already built for `/listening`. All three render nothing until their fetch lands
  and nothing at all if it fails, so the prerendered shell never depends on them.
- **📸 Recent photos** shows the four most recent *photographs*, by capture date, each
  linking into the gallery lightbox at that frame. It previously showed the four newest
  *galleries'* cover images, so the heading was untrue — a 2020 cover under "Recent
  photos" — and it only changed when a whole gallery was added. Galleries with no capture
  dates fall back to covers, so the section can't vanish.

## Colophon (`/colophon`)

A "how this is built" page, linked from the footer. **The prose lives in
`content/colophon.md`** — edit that, not the page component (same arrangement as
`content/projects.md`; `title`, `lead`, and `description` come from its frontmatter).

Above it sits a row of counters: posts, words, and photos are counted at **build time**
from the same content the pages render from; scrobbles, books, and articles are fetched in
the browser from the two Workers when the page loads. Each live tile renders only once its
number lands, so a Worker being down costs the page three tiles and nothing else.

### Numbers in the prose

The body can quote the build-time counts, substituted by `fillTemplate` in
`src/lib/colophon.ts` before the Markdown is rendered. Two forms, and deliberately no more —
it's a fill-in-the-blanks step, not a template language:

```markdown
{{photos}} photographs across {{galleries}} galleries…

{{#located}}
{{located}} of them carry a location…
{{/located}}
```

- Available keys: `posts`, `words`, `photos`, `galleries`, `located` — whatever `ColophonData`
  carries. Numbers are thousands-separated. `posts` and `words` also feed the tiles, so they
  stay defined whether or not the prose quotes them.
- `{{#key}}…{{/key}}` keeps its contents only when that count is non-zero. That exists
  because "0 of them carry a location" is a sentence that shouldn't be published — a repo
  whose photos carry no EXIF just doesn't get that paragraph.
- An unknown placeholder is **left in the text**, not blanked, so a typo shows up as
  `{{photoss}}` the first time you preview the page rather than quietly deleting half a
  sentence.
- Root-relative links in the body render as client-side `<Link>`s; external ones are plain
  anchors.

### Where the live numbers come from

- Scrobbles come from the listening Worker's `/now.json`, which already carries Last.fm's
  own all-time total — no `COUNT(*)`, and the smallest endpoint on the site. The field is
  optional in `NowState` so a Worker deployed before it existed reads as *absent* rather
  than as zero.
- Books and articles come from `/reading.json` (the counts aren't on the reading Worker's
  smaller endpoint).
- Photo counts skip alias galleries (`/past-work` → `/2022`), which would otherwise count
  the same photos twice.

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
- **Terminal view:** `curl reading.cailinpitt.com` renders the same data as an
  ANSI page, like `/listening` does. Dispatch is on User-Agent, so `/reading.json`
  is unaffected; `?T` turns off color.
- **Setup, design notes, and how to test each piece separately:** see
  [`worker-reading/README.md`](worker-reading/README.md).
- **Check the Hardcover query without deploying:** `npm run reading:probe`
  (needs `HARDCOVER_TOKEN` in `.env`).
- **API base URL:** set `VITE_READING_API` at build time (defaults to
  `https://reading.cailinpitt.com`).

## Guestbook (`/guestbook`)

Anyone can sign it: name and message required, website and location optional, plus a
country flag derived from the request (no field to fill in). Same shape as the other
two activity pages — a standalone Cloudflare Worker (`worker-guestbook/`) owns the
data and the page fetches JSON in the browser — except this is the one endpoint on
the site that accepts **writes from the public**.

- **Moderation** is after the fact, from the repo root:

  ```sh
  npm run guestbook:list                    # 50 newest entries, with ids
  npm run guestbook:list -- --limit 200     # more
  npm run guestbook:rm -- <id> [<id> ...]   # delete, one or many
  ```

  `list` prints the id first on each line — that is what you paste into `rm`. It also
  tags repeats from a single IP hash (`[4x from 1a7c07a3]`), which is how a flood
  shows up when it is wearing ten different names. Both need `GUESTBOOK_ADMIN_TOKEN`
  in `.env`, matching the Worker's `ADMIN_TOKEN` secret. **Deleting is immediate and
  permanent** — there is no pending state and no trash.
- **Entries publish instantly.** What makes that affordable is a layered write path —
  origin check, hidden honeypot field, [Turnstile](https://www.cloudflare.com/products/turnstile/),
  validation, per-IP limits (3/hour, 10/day), and a global 60/hour circuit breaker.
  Turnstile is the load-bearing one and fails closed, so an outage makes the guestbook
  read-only rather than open. Its script loads only once someone starts filling in the
  form, so readers never pay for it.
- **Deleting an entry returns that IP's hourly quota**, because the rate limit counts
  rows. Handy for testing; worth knowing it means deletion won't slow a persistent
  signer down.
- **Terminal view:** `curl guestbook.cailinpitt.com`, like `/listening` and `/reading`.
- **Setup, the full write path, and the privacy design:** see
  [`worker-guestbook/README.md`](worker-guestbook/README.md).
- **API base URL:** set `VITE_GUESTBOOK_API` at build time (defaults to
  `https://guestbook.cailinpitt.com`). The Turnstile **site** key is public and lives
  in `src/lib/guestbook.ts` and `worker-guestbook/wrangler.jsonc`; keep the two in sync.

## Photo map (`/photos/map`)

Plots every photo that carries a location — i.e. the galleries built from `originals/`,
since the coordinates come from the EXIF that `images:sync` records. Photos sharing a
rounded coordinate collapse into one pin, and each popup links into the gallery lightbox
at that frame.

- **Leaflet** (BSD-2-Clause, bundled from npm — no CDN) with raster tiles from
  **OpenStreetMap**. Both are free with no account, no API key, and no billing to
  misconfigure; the attribution line the tile policy requires is on the map.
- Leaflet reads `window` on import, so it's pulled in inside the effect rather than at
  module scope — the page shell prerenders like any other and the map fills in after
  mount. Vite splits it into its own JS **and** CSS chunk, so no other page loads it.
- Pins are `circleMarker`s (drawn, not images), which sidesteps Leaflet's bundler-hostile
  default marker icon URLs and lets them take the site's accent color.
- In dark mode the tile pane is inverted and hue-rotated, since OSM's tiles are drawn for
  light backgrounds. Markers live in a pane above it and keep their real color.
- Positions are rounded to ~0.7 miles (see [above](#add-a-photo-gallery-eg-2026)), which the
  page says plainly — a pin marks a neighborhood, not a spot.

## Timeline (`/timeline`)

One row per day, merging all five activity streams: scrobbles, saved articles, books
started/finished, published posts, and photos taken. Nothing new is stored — the page
fetches the same `/listening.json` and `/reading.json` bundles the other two pages use
and merges them in the browser against the posts and photos compiled into the build
(`src/lib/timeline.ts`).

- **How far back it goes** is set by the listening days, the densest stream and the only
  one worth a real cursor. Everything else is filtered into that window, and "load older"
  pulls another block of days and tops the other streams up to match. Once listening is
  exhausted there's no floor and the rest of the history shows — currently ~77 rows back
  to 2015.
- **A day with no scrobbles still gets a row** if anything else happened on it. The
  listening days seed the timeline; they don't limit it.
- **Photos only appear from 2026 on**, since placing one in time needs the capture date
  recorded by `images:sync` (see [above](#add-a-photo-gallery-eg-2026)) and the older
  galleries came out of Squarespace EXIF-stripped. Each thumbnail links straight into the
  gallery lightbox at that frame.
- **Day bucketing is inherited from each stream, not recomputed** — the Worker groups
  scrobbles into US Central days while articles bucket in the viewer's zone, so the two
  disagree at the margins for a visitor far from Central. See the note at the top of
  `src/lib/datetime.ts`; it's a property of the data, not something this page can fix.

## Social cards

Every prerendered page gets its own 1200×630 Open Graph card at `/og/<path>.jpg`, written by
`scripts/generate-og.mjs` as part of `postbuild` (`npm run og` re-runs it against an existing
`dist/`; `npm run og -- --only /blog/…` does a single page, and `--out .og-preview` writes
somewhere you can look at without touching the build).

- **Two layouts.** Pages with a photograph — blog posts with images, gallery years — put it
  full-bleed under an ink scrim with the title over it. Everything else gets the paper card:
  the site's paper/ink palette, a clay spine off the left edge, the title and description
  between two hairline rules.
- **Copy comes from the built HTML.** The script reads each page's own `og:title` and
  `og:description` rather than re-deriving them, so a card can't drift from the page it
  belongs to. Anything only the page knows — its kicker, its date and reading time, which
  photo to use — `<Seo card={{…}}>` emits as a `<meta name="og-card">` hint for the script
  to pick up (`src/components/Seo.tsx`).
- **Photographs are fetched from R2** at build time, falling back to a local `public/images`
  copy when there is one. If a photo can't be fetched the page quietly gets the paper card
  instead — a broken image URL doesn't fail a deploy.
- **Type is Source Serif 4 + Inter**, not the site's own Iowan Old Style/`system-ui`, which a
  Linux runner doesn't have. They ship as `.woff` in `node_modules`, so no font binaries live
  in the repo; satori converts glyphs to paths, so nothing needs fonts at render time.
- Card paths are built in two places — `ogCardPath()` in `Seo.tsx` and `cardFile()` in the
  script. They must agree, or pages point at a 404.

## Tests

`npm test` (vitest, no config file — it picks up `vite.config.ts`, so the `virtual:site-index`
plugin and `import.meta.glob` resolve the same way they do in a build). Everything lives in
`tests/`, runs in well under a second, and touches no network, no `dist/`, and no images.

That last part is the rule the suite is built around: **a test has to pass on a fresh clone.**
`public/images/` and `originals/` are gitignored, so CI has no photographs — which is also why
`npm run images:check` is *not* in the workflow. It would report every blog image as missing on
disk and fail every build. Run it locally, where the files exist.

What's covered, and why each one:

- **`frontmatter`, `posts`, `tags`, `colophon`** — the pure functions the whole build leans on.
  These fail quietly rather than loudly: a tag slug that stops collapsing casing splits one tag
  into two pages, a broken `{{#located}}` section publishes "0 of them carry a location", and a
  word counter that starts counting iframes tells a photo essay it's a 12 minute read. Nothing
  about a green build would look wrong.
- **`content`** — the posts on disk, checked for the frontmatter facts the build trusts without
  verifying: two posts sharing a `path` silently prerender over each other, a `path` whose date
  disagrees with `date:` puts a post at a URL contradicting itself, and a mistyped `tags:` array
  arrives as a string. The path check is padding-agnostic, since one post is at `/blog/2026/8/01/…`
  rather than the usual unpadded `/8/1/`.
- **`guestbook-validate`** — the one piece of code that decides what a stranger may store. It
  lives in `worker-guestbook/`, which has no test setup of its own, but it's pure, so it's
  tested from here.
- **`command-palette`** — the hand-written page list, held against the router (see [Search](#search-k)).

The workflow runs `typecheck` → `test` → `build`, so a broken invariant stops a deploy rather
than shipping.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to
GitHub Pages. In the repo: **Settings → Pages → Source = GitHub Actions**. The custom domain is
set via `public/CNAME`.

The three Workers deploy **separately** and are not part of that pipeline — a push to
`main` never touches them. Each is its own package, deployed by hand from its directory:

```sh
cd worker && npm run deploy            # listening.cailinpitt.com
cd worker-reading && npm run deploy    # reading.cailinpitt.com
cd worker-guestbook && npm run deploy  # guestbook.cailinpitt.com
```
