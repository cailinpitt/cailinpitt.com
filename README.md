# [cailinpitt.com](https://cailinpitt.com)

Personal site: blog, photography, projects. React + Vite prerendered to static HTML with
[`vite-react-ssg`](https://github.com/Daydreamer-riri/vite-react-ssg), deployed to GitHub Pages.
Five Cloudflare Workers back the live-data pages.

```bash
npm install
npm run dev        # dev server
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run build      # prerender → dist/ (+ sitemap.xml, llms.txt, feed.xml, og cards)
npm run preview    # serve dist/
```

**Looking for a command?** [`RUNBOOK.md`](RUNBOOK.md) is every command in the repo, by task. This
file explains how things work.

## Contents

- [Blog posts](#blog-posts) · [Photos](#photos) · [standard.site / Bluesky](#standardsite--bluesky)
- Pages: [/now](#now) · [/uses](#uses) · [/listening](#listening) · [/reading](#reading) ·
  [/watching](#watching) · [/moving](#moving) · [/guestbook](#guestbook) · [/timeline](#timeline) ·
  [/photos](#photos-page) ·
  [/photos/map](#photo-map) · [/colophon](#colophon) · [/blog](#blog-index) ·
  [/terminal](#terminal)
- Build features: [social cards](#social-cards) · [RSS](#rss-feed) · [search](#search-k) ·
  [header nav](#header-nav) · [theme](#color-theme) · [markdown source](#markdown-source) ·
  [provenance](#provenance)
- [Phone photo publishing](#publishing-a-photo-from-your-phone) · [Tests](#tests) · [Deploy](#deploy)

## Blog posts

Create `content/blog/<slug>.md`. Posts are picked up by glob — no routing to wire.

```markdown
---
title: "Post title"
date: 2026-01-15
updated: 2026-02-03            # optional; only for substantive revisions
path: /blog/2026/1/15/post-slug  # exact URL, non-zero-padded, must be unique
slug: post-slug
tags: ["music"]
description: "Summary for listings + social cards."  # optional
image: /images/post-slug/cover.jpg                   # optional cover/social image
---
```

`path` is the literal URL the post prerenders to (the old Squarespace convention). It must be
unique — two posts sharing one silently overwrite each other. `tests/content.test.ts` checks this.

**Publishing checklist**

1. Write `content/blog/<slug>.md`.
2. Put inline images in `originals/<slug>/`, run `npm run images:publish`, and reference them as
   `/images/<slug>/<name>.webp` (note: extension changes to `.webp`).
3. Preview with `npm run dev`.
4. `npm run publish:atproto`, then commit `content/atproto.json`.
5. Commit the post and push `main`.

**What happens automatically**

| Feature | Notes |
|---|---|
| Rendering | `react-markdown` + `remark-gfm` + `rehype-raw` (so YouTube/Spotify iframes survive) |
| Tags | Free text. Each gets a prerendered `/blog/tag/<slug>`. Grouped by slug, so casing can't split a tag; a typo makes a new one |
| Social card | Built per page. `image:` picks the photo behind the title; falls back to the first body image, then the paper card |
| Reading time | Counted from prose only. Under 100 words shows nothing |
| Related posts | Up to three sharing the most tags; none if the post has no tags |
| Heading anchors | `rehype-slug` ids + a `#` self-link, hidden until hover/focus. Stripped from RSS |
| Markdown source | Every post publishes its source at `<post path>.md`, and a **Markdown** toggle above the body swaps the rendered article for the raw source in place, with Copy. See [Markdown source](#markdown-source) |
| Provenance | A line at the foot of the post, read from `git log` at build time: when the file arrived and how many times it alone was edited since. Each commit opens a word-level diff of what it changed. See [Provenance](#provenance) |
| `updated:` | Renders in the meta line and JSON-LD `dateModified` |
| Listings | `/blog`, home page, `sitemap.xml`, `llms.txt`, JSON-LD, RSS |

### Markdown source

Every post is readable as the file it was written in, and so are the two pages that *are* a
Markdown file — `/colophon.md` and `/projects.md`.

- `scripts/generate-markdown.mjs` (postbuild) copies `content/blog/<slug>.md` byte-for-byte to
  `dist/<post path>.md`, so <https://cailinpitt.com/blog/2023/3/3/paramore-this-is-why-2023.md>
  is the source, frontmatter and all. GitHub Pages serves it as
  `text/markdown; charset=utf-8`, which browsers show inline.
- **A `.md` sitting directly in `content/` is a page whose route is its name**, and its source
  publishes at `/<name>.md`. That one rule is what `generate-markdown.mjs`, the dev middleware in
  `vite.config.ts`, and the history plugin all apply, so adding `content/uses.md` later needs no
  changes to any of them. The colophon's source keeps its `{{placeholders}}` — the numbers are
  filled in when the page renders, and the file is what was written.
- On the page, the **Markdown** toggle above the body (`src/components/PostSource.tsx`) swaps the
  rendered article for a `<pre>` of the source, with Copy and a link to the file. It reads the body
  out of the loader data the page already renders from — no request, and it can't disagree with
  what's on screen. The inline view has no frontmatter; the file does.
- Each post's `<head>` advertises the file as
  `<link rel="alternate" type="text/markdown">`, so a crawler can find it.
- Body images read `/images/...` in the source, not the R2 URLs they're rewritten to at render
  time — the source says what you'd paste back into a post.
- The dev server serves the same URLs (a middleware in `vite.config.ts`), so the link isn't a
  production-only feature that only breaks in production.

### Provenance

Each post ends with one quiet line about its own file — "Edited 6 times since August 1, 2026" —
that expands into the list of commits, each linking to GitHub. `/colophon` carries the same line,
for the same reason: it's a Markdown file in this repo like any post.

The counting is the whole design. This repo's history starts in June 2026: 31 posts arrived from
Squarespace in one commit and were reformatted in a second the next day. Counting those would tell
every pre-2026 post the same lie ("revised twice") about the repo's plumbing rather than the
writing. So **a commit touching `BULK_POSTS` (3) or more posts is shown but not counted**, and a
post that has never been edited on its own says only when it turned up: "Imported June 20, 2026",
with a note explaining the migration. Bulk rows in the list are marked `31 POSTS`.

Each commit's subject opens the **diff** of what it changed in this post, as track-changes prose:
the paragraph with what came out struck through and what went in marked, in `<ins>`/`<del>` so the
change is in the markup and not only the color.

Markdown puts a whole paragraph on one line, so git's line diff reports a 1,200-character
paragraph deleted and a near-identical one added to fix `turnes` → `turned`. Three things make
that readable, all at build time:

| | |
|---|---|
| **Word refinement** | Git decides which lines correspond; `wordDiff()` refines each pair to the words that changed. An LCS table — quadratic, but one paragraph at a time |
| **Elision** | Unchanged runs longer than ~90 characters of context collapse to a `…` chip, so a diff opens *on* the change instead of a wall of prose. Also cut this post's loader data from 24 KB to 16 KB |
| **Similarity floor** | Below 30% shared text the pair is a rewrite, not an edit, and shows as whole `−`/`+` lines — word-marking every token would be confetti. This is what the "Polish" commit's `description:` rewrite looks like |

The commit that *added* a post has no diff: it would be the post. Diffs are collected with one
`git show` per commit, not per commit per post — the reformat that touched 31 posts is one patch.

- `src/lib/diff.ts` — parsing, word refinement, and elision, pure and covered by
  `tests/diff.test.ts`
- `src/lib/history.ts` — types, the `git log` invocation, and the parsing/filtering, kept pure and
  covered by `tests/history.test.ts`
- `cailinpitt:post-history` in `vite.config.ts` — one `git log` for the whole of `content/` at
  build time, exposed as `virtual:post-history`, keyed by route (a post's `path:`, a page's
  filename). Renames aren't followed
- `src/components/PostHistory.tsx` — the line itself, outside the `<article>`

> **`fetch-depth: 0` is required.** `.github/workflows/deploy.yml` checks out full history for
> this. At the default shallow depth every post would claim to have been added in the most recent
> commit. Outside a git repo the map comes back empty and the line doesn't render at all.

Also: **`.post-body` must stay the last thing inside `<article>`.** `scripts/generate-rss.mjs`
finds the end of a post by looking for the literal `</div></article>`; anything added after the
body inside the article silently empties every feed item down to its summary.

Images are rewritten to Cloudflare R2 at render time and are **never committed**.
`npm run images:sync` reports images a post references but that aren't on disk, plus files nothing
references.

## Photos

All images (blog + photos) are served from R2 (`images.cailinpitt.com`); `public/images/` and
`originals/` are both gitignored. Photos are one flat chronological feed at `/photos`, described by
`src/lib/photos.json`. No gallery registry.

```bash
# 1. Drop full-size camera files in originals/2026/  (a four-digit folder = "this is a photo")
npm run images:publish     # = images:sync + images:upload; needs R2 creds in .env
# 2. Commit src/lib/photos.json — never the photos
```

### What `images:sync` does

- **Compresses.** Each original becomes two WebPs in `public/images/<folder>/`: 2560px full size
  and a 1000px `-1000.webp` thumbnail (quality 82, EXIF orientation baked in, metadata stripped).
  Skipped when a rendition is newer than its original.
- **Rebuilds `src/lib/photos.json`** from disk: `src`, `thumb`, `width`/`height`. Existing entries
  keep their id, alt, date, and EXIF, so hand-edits survive. New files are appended, list sorted
  newest-first.
- **Assigns a permanent id** — `<year>-<filename>`, e.g. `2019-img-0116` — on first sight and
  **never recomputes it**, because it's the URL of `/photos/<id>`. Repeats within a year get `-2`.
- **Records EXIF** from the original: date, camera, aperture, shutter, ISO, focal length, coarse
  location. Read once, then left alone (useful when a camera reports a model code — the drone says
  `FC3170`).
- **Dates every photo**: EXIF capture time, else the existing manifest value, else Jan 1 of the
  folder year. Anything but the first is marked `approx` and renders as a bare year.
- **Never deletes silently.** Entries whose file is missing are kept unless you pass `--prune`.

```bash
npm run images:sync -- --prune      # drop entries whose file is gone
npm run images:sync -- --reexif     # re-read EXIF from originals
npm run images:sync -- --reencode   # rebuild every rendition
npm run images:check                # report only; non-zero exit if out of date
npm run images:upload -- --dry-run  # show what would upload to R2
npm run images:prune                # list unreferenced R2 objects
npm run images:prune -- --delete    # …and delete them
```

> **Location privacy.** `photos.json` is committed and public, so GPS is rounded to 2 decimal
> places (~0.7 miles) on the way in — enough for a neighborhood, not an address. Full precision
> stays in the gitignored originals. To publish nothing, drop the `place` field in
> `scripts/exif.mjs` and re-run with `--reexif`.

`originals/` is a local working directory, **not a backup**. Keep your real originals elsewhere.

### Removing a photo

```sh
npm run photos:rm -- 2026-img-1919              # delete
npm run photos:rm -- <id> --dry-run             # look first
npm run photos:rm -- <url>                      # a photo URL works too
npm run photos:rm -- <id> <id> <id>             # several
```

Removes all five pieces: manifest entry, both local renditions, both R2 objects, the original, and
the archived original in the private bucket. Then commit `src/lib/photos.json`. Immediate and
permanent, like `guestbook:rm`.

**The original must go too.** `images:sync` rebuilds renditions from `originals/`, so sparing the
original republishes the photo at the same URL on the next sync. Move it out of the repo first if
you want to keep it.

An unknown id is an error; a missing archived original is only a warning.

### `images:prune`

Cleans up R2 objects superseded when photos get new renditions. Compares the bucket against every
`src`/`thumb` in the manifest and every `/images/...` path in blog markdown, and refuses to delete
if anything referenced is missing from the bucket (so a half-finished upload can't look like a
bucket of orphans). `PROTECTED_PREFIXES` (currently `images/reading/`) is never touched — those
objects belong to the reading Worker and are referenced from D1, which this script can't see.
Deleted objects may still serve from the edge cache; purge in the dashboard if urgent.

### Dates before 2026

Only 2026 photos carry EXIF; everything older came back from Squarespace stripped. Dates were
recovered from the Squarespace export, where each CDN URL embeds the **upload** time:

```bash
npm run photos:backfill      # --dry-run to look first
```

That reached 454 of 460 older photos. Because it's upload time, not capture time:

- entries are flagged `approx` and the site prints only the year;
- the photo keeps the **year of its folder**, not the recovered year (a 2014 photo posted in 2016
  stays 2014) — which is why entries carry both `year` and `date`;
- `/timeline` skips approximate photos entirely.

The script only replaces the Jan-1 placeholder, so it's safe to re-run and safe to hand-correct
afterward.

## standard.site / Bluesky

`scripts/publish-atproto.mjs` upserts one `site.standard.publication` record plus one
`site.standard.document` per post into your Bluesky PDS, so posts render as first-class long-form
documents rather than link cards. The build reads the AT-URIs from `content/atproto.json` — the
build itself needs **no** credentials.

```bash
npm run publish:atproto              # create/update records, rewrite content/atproto.json
npm run publish:atproto -- --dry-run # preview; no login, no writes
```

`.env` (gitignored), using an [app password](https://bsky.app/settings/app-passwords):

```
BLUESKY_IDENTIFIER=yourhandle.bsky.social
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
# BLUESKY_PDS=https://bsky.social   # optional
```

Idempotent — stable record keys (`self` for the publication, the slug per document) mean re-running
updates in place. Re-run whenever post content or metadata changes, then commit
`content/atproto.json`. The DIDs and AT-URIs in it are public identifiers.

## Now

`/now` is a [now page](https://nownownow.org/about/): what has my attention at the moment, which is
a different question from what `/blog` or `/projects` answers. Prose lives in **`content/now.md`** —
edit that, not `src/pages/Now.tsx`.

- **The "Updated" date comes from `git log`, not frontmatter.** The whole claim a now page makes is
  that it was true recently, and a hand-maintained date is exactly the field you forget to bump in
  the edit where it matters. It's the newest commit to touch the file, read from the same
  `virtual:post-history` the [provenance](#provenance) line at the foot uses.
- **Now-playing, currently-reading, and the three newest photographs sit above the prose.** The
  rest of the page is true as of the date; those are true as of now. The two bars are the
  homepage's and render nothing until their fetch lands, so a Worker being down costs the page a
  strip and nothing else; the photographs come from the build and are prerendered.
  `<PhotoStrip>` is shared with the homepage, which shows four.
- Like the colophon it gets a **Markdown** toggle, publishes its source at `/now.md`, and answers
  to `cat now` in [/terminal](#terminal) — all of which come free from being a `.md` in `content/`.
- Reached from the **Me** menu in the header (see [header nav](#header-nav)) and from a line in
  the homepage intro, and listed first in `llms.txt`, it being the page that answers "what is this
  person doing".

## Uses

`/uses` is a [uses.tech](https://uses.tech/) page: the hardware, software, and services I actually
reach for. Prose lives in **`content/uses.md`**.

Structurally it's `/now` without the live block — same "Updated" date read from `git log`, same
Markdown toggle, same provenance line, all of it falling out of being a `.md` in `content/`.
Reached from the **Me** menu in the header (see [header nav](#header-nav)), and listed under
**Setup** in `llms.txt`.

> **Three pages now share this shape** — `/now`, `/uses`, and `/colophon` each render one Markdown
> file with a source toggle and a history panel, and the JSX for that is copied three times. Worth
> extracting if a fourth turns up.

## Listening

`/listening` shows now-playing, 7d/30d stats, a year heatmap, and a daily scrobble log from
Last.fm. The Worker in `worker-listening/` ingests into D1 on a cron and serves a cached JSON
bundle; the static page fetches it in the browser.

- Setup and cost design: [`worker-listening/README.md`](worker-listening/README.md)
- Full-history backfill: `node scripts/backfill-listening.mjs` (needs `LASTFM_API_KEY` in `.env`),
  then load the SQL into D1
- API base: `VITE_LISTENING_API` at build time (default `https://listening.cailinpitt.com`)
- `/sparkline.json` feeds the homepage sparkline — a projection of the heatmap blob, so one KV read
  and no D1. Today's bar inherits the heatmap's ~6h cadence and can read low. **Requires the Worker
  to be deployed**; until then it 404s and the sparkline doesn't render.

### Period views

`/listening/2026`, `/listening/2026/08`, `/listening/2026/W32` and `/listening/all` are one page
(`ListeningPeriod.tsx`) rendering one blob shape at four granularities: leaderboards with rank
movement, the hour/weekday/168-cell "when I listen" charts, discovery, streaks, sessions, album
listens and milestones. Design notes and the full stat catalog live in
[`plan-listening-stats.md`](plan-listening-stats.md).

`/listening/wrapped` (and `/listening/wrapped/<year>`) tells the same year as a narrative. Every
`/listening/<year>` page links to its story, and the wrapped page carries a year switcher, so no
year is reachable only by typing a URL. The copy is **first person** — this is Cailin's listening on
Cailin's site, so it says "I played", never "you played"; a test asserts no card or trait addresses
the reader. It reads
the same blob and adds no endpoint — everything is derived in `src/lib/wrapped.ts`, which is where
the thresholds live. It deliberately stays quiet rather than guessing: cards and traits are dropped
when their inputs are missing, genre and geography claims need >=50% coverage, and a period under
50 scrobbles gets no story at all.

**"New" means first ever heard, not new to the chart.** A leaderboard entry absent from the
previous period's top 25 is not necessarily new — it may have years of plays and simply have ranked
lower. `prevRank` answers the chart question and drives ▲/▼ (and ↩ for a re-entry); `isNew` answers
the history one, filled from `artists.first_uts` by `markNewEntries()`. Conflating them contradicted
the Discovery section, which has always meant first-ever play.

**The rule that makes it affordable: aggregation happens on the cron, never on a request.** A
period endpoint reads a finished KV blob or 404s. `/<year>` and `/<year>.json` on the Worker are
aliases for the same blob, so `curl listening.cailinpitt.com/2025` shows the same year the site
does, genres and listening time included — there is no longer a second year implementation
aggregating from D1 per cache miss. Nothing a visitor can do causes a D1 scan, so
cost per visitor is flat no matter how much traffic arrives.

- Week keys are **ISO weeks** (Monday-start, `2026-W32`). The `/listening` heatmap is Sunday-start
  because it mimics a contribution calendar; it isn't addressable, so the two never need to agree.
- Static paths come from date arithmetic over `FIRST_LISTENING_DAY`, not the API — same reason
  `listeningYears.ts` does, so a Worker outage can't fail a deploy.
- `src/lib/periodKeys.ts` and `worker-listening/src/periods.ts` do the same calendar maths on both
  sides. `tests/period-keys.test.ts` pins them to each other; if they drift, pages resolve to the
  wrong data.
- **While moving** intersects scrobble timestamps with activity windows from `worker-moving`
  (`/windows.json`). The window is **not** raw `elapsed_time` — recordings get left running, and
  across 2021 elapsed totals 1,081 hours against 304 of actual movement, so a 40-minute ride would
  have claimed the whole evening. It is moving time plus a 30-minute pause allowance, capped at
  what was recorded. It is the one cross-Worker dependency, and it is deliberately one-way and
  failure-tolerant: `fetchWindows` never rejects, so an unreachable moving Worker costs that section
  and nothing else. Set `MOVING_API` empty to turn it off.
- Period pages reuse `/og/listening.jpg` rather than generating their own card. There are ~360 of
  them growing by 52 a year, and at ~1 card/second that was ~6 minutes of every build spent on URLs
  nobody shares — the same trade the photo permalinks make. **The wrapped pages are the exception**
  and keep bespoke cards: six of them, and a year in review is the one page here worth sharing.
- Completed periods are baked into `public/listening-data/` at build time (gitignored) and served
  as static assets, which don't count against the Workers request ceiling. The client falls back to
  the API when a file is absent.

### Music while moving

`/moving` rows expand to show what was playing during that activity — and the expander only
appears on activities that actually have music. That check is one batched `/during-counts` request
per page of activities rather than one per row, and it doubles as the label ("♫ 12 tracks").

Expanding costs nothing until someone opens a row: the row then asks the listening Worker's `/during?from=&to=`, which is an index
range of a couple of dozen scrobbles. No precomputation, no extra KV, and a finished window caches
at the edge for a day.

The window comes from `windowSeconds` on the activity, served by `worker-moving` so the rule lives
in one place — moving time plus a 30-minute pause allowance, capped at what was recorded, never raw
`elapsed_time`.

## Reading

`/reading` shows books (from [hardcover.app](https://hardcover.app)) and saved articles with cover
art. Owned by `worker-reading/`.

- **Books** sync from Hardcover's GraphQL API on a daily cron into D1. Full replace, so the first
  run imports everything — no backfill script.
- **Articles** are pushed to an authenticated `POST /ingest`, which fetches `og:` metadata and the
  social card. Saved from an iOS/macOS Shortcut or a desktop bookmarklet.
- **Images** mirror into the photos R2 bucket under `images/reading/`, protected from
  `images:prune` by `PROTECTED_PREFIXES`.
- **Terminal view:** `curl reading.cailinpitt.com`; `?T` disables color.
- Check the Hardcover query without deploying: `npm run reading:probe` (needs `HARDCOVER_TOKEN`).
- API base: `VITE_READING_API` (default `https://reading.cailinpitt.com`).
- Setup and testing: [`worker-reading/README.md`](worker-reading/README.md)

## Watching

`/watching` shows films with their posters and half-star ratings, grouped by the year they were
watched. Owned by `worker-watching/`.

- **Films** sync from the Letterboxd diary **RSS feed** on a daily cron — Letterboxd has no public
  API, but the feed carries the rating, watched date, rewatch flag, TMDB id, and poster in named
  fields, so nothing here parses markup. Letterboxd 403s a non-browser `user-agent`; the one in
  `fetchDiary()` is load-bearing.
- **Upserts, not a full replace** (unlike Reading): the feed is only the newest 50 entries, so a
  replace would drop the archive on every run. Rows are keyed `<slug>|<watched date>` rather than
  the feed's guid, which changes when a review is added later.
- **History before those 50** comes from a one-off CSV import: `npm run watching:backfill
  <diary.csv>` writes SQL for `wrangler d1 execute`. The export's "Letterboxd URI" is a `boxd.it`
  short link, so the script resolves each one to its real film slug (cached in
  `scripts/.watching-slugs.json`) — slugifying the title instead produces dead links and duplicate
  rows.
- **Reviews are deliberately not stored**, and cards link to `letterboxd.com/film/<slug>`, never to
  the diary entry under `/<member>/`.
- **Images** mirror into the photos R2 bucket under `images/watching/`, protected from
  `images:prune` by `PROTECTED_PREFIXES`.
- **Terminal view:** `curl watching.cailinpitt.com`; `?T` disables color.
- Run the sync now: `npm run watching:sync` (`-- --posters` loops until poster mirroring is done).
- API base: `VITE_WATCHING_API` (default `https://watching.cailinpitt.com`).
- Setup and testing: [`worker-watching/README.md`](worker-watching/README.md)

## Moving

`/moving` is a day-by-day log of bike rides and lifting sessions, one line each — "Biked 10.1
miles", "Lifted for 43m". Owned by `worker-moving/`.

- **Nothing user-facing names the source.** The page, nav, terminal view, and row copy are all
  deliberately vague about where the data comes from; the Worker and these docs say Strava freely.
  Keep that in mind when editing copy.
- **Activities sync from the Strava API** every 30 minutes, asking only for the last week plus a
  7-day overlap so renames and late manual entries land. Standard Tier access requires an active
  Strava subscription as of June 2026, and downstream relays are now barred from serving Strava
  data, so there is no free automated path.
- **The refresh token rotates on every exchange**, so it lives in an `auth` row in D1 rather than a
  Worker secret — secrets are write-only from the Worker's side. `STRAVA_REFRESH_TOKEN` seeds the
  first run only.
- **History came from the bulk export**: `npm run moving:backfill <activities.csv>` writes SQL for
  `wrangler d1 execute`. Ids are Strava's own, so an imported row and the same activity fetched
  later are the same row — the export and the API cannot duplicate each other.
- **The export has no local timestamp**, only UTC, so backfilled dates are approximated with a
  fixed Central offset and are wrong across DST and travel. `npm run moving:sync -- --refresh`
  re-pulls every stored row and takes Strava's own per-activity local date. It is required after a
  backfill, not optional.
- **`kind` is derived from `sport_type`** — ride, ebike, lift, walk, run, yoga, climb, other.
  E-bikes are split from ordinary rides. After changing that mapping, run
  `scripts/moving-recategorize.sql`: the sync only rewrites rows it fetched.
- **No polylines, coordinates, or streams are stored**, and `name` and `commute` are stored but not
  served — the log renders a summary built from the numbers.
- **Terminal view:** `curl moving.cailinpitt.com`; `?T` disables color.
- Run the sync now: `npm run moving:sync` (`-- --refresh` re-pulls history).
- API base: `VITE_MOVING_API` (default `https://moving.cailinpitt.com`).
- Setup and testing: [`worker-moving/README.md`](worker-moving/README.md)

## Guestbook

Anyone can sign `/guestbook`: name and message required, website and location optional, country
flag derived from the request. Owned by `worker-guestbook/` — the only endpoint on the site that
accepts **public writes**.

- **Moderation** is after the fact, from the repo root (needs `GUESTBOOK_ADMIN_TOKEN` in `.env`
  matching the Worker's `ADMIN_TOKEN`):

  ```sh
  npm run guestbook:list                    # 50 newest, with ids
  npm run guestbook:list -- --limit 200
  npm run guestbook:rm -- <id> [<id> ...]   # immediate and permanent
  ```

  `list` prints the id first on each line and tags repeats from one IP hash
  (`[4x from 1a7c07a3]`) — how a flood looks when it wears ten names.
- **Entries publish instantly**, made affordable by a layered write path: origin check, honeypot,
  [Turnstile](https://www.cloudflare.com/products/turnstile/), validation, per-IP limits (3/hour,
  10/day), and a global 60/hour breaker. Turnstile is load-bearing and fails closed, so an outage
  makes the guestbook read-only, not open. Its script loads only once someone starts typing.
- **Deleting returns that IP's hourly quota**, since the limit counts rows.
- **Terminal view:** `curl guestbook.cailinpitt.com`.
- API base: `VITE_GUESTBOOK_API` (default `https://guestbook.cailinpitt.com`). The Turnstile
  **site** key is public and lives in both `src/lib/guestbook.ts` and
  `worker-guestbook/wrangler.jsonc` — keep them in sync.
- Full write path and privacy design: [`worker-guestbook/README.md`](worker-guestbook/README.md)

## Photos page

One Instagram-style feed: every photograph in a three-column grid of squares, newest first, no
pagination. There are no galleries — `/2019`, `/latest`, `/past-work` and friends now 404.

- **Every photo has a page** at `/photos/<id>`, prerendered, with the full-size image, date, camera
  settings, a map link when it has coordinates, and prev/next (←/→ work too).
- **Each tile paints its photo's average color** while the image loads (`tint` in the manifest,
  computed by `scripts/tint.mjs` during `images:sync`), so scrolling the feed is photographs
  arriving rather than a grid of identical gray squares. 7 bytes per photo.
- **A floating marker names the year** at the top of the feed as you scroll — measured off the
  year-break tiles that already carry the `#y2019` anchors, so it needs no extra markup and
  degrades to nothing without JavaScript.
- **The whole feed is in the prerendered HTML.** ~500 lazy `<img>` tags gzip to ~20 KB, which buys
  a page that works without JavaScript, is Cmd-F searchable, and has real year anchors
  (`/photos#y2019`). Loader data carries only what a tile needs — no EXIF, no dates.
- **Ordering** is year first, then date within the year, because a pre-2026 date can be a recovered
  upload time that landed in the following year.
- **The social card is the photograph itself**, so `generate-og.mjs` skips these pages — otherwise
  a deploy would render ~500 cards.

## Photo map

`/photos/map` plots every photo with a location (i.e. the 2026 ones). Photos sharing a rounded
coordinate collapse into one pin; each popup links to the photo's page.

- **Leaflet** (BSD-2-Clause, bundled from npm) with **OpenStreetMap** raster tiles. No account, no
  API key, no billing. Attribution is on the map as the tile policy requires.
- Leaflet reads `window` on import, so it's imported inside the effect — the shell prerenders and
  the map fills in after mount. Vite splits it into its own JS and CSS chunk.
- Pins are `circleMarker`s, avoiding Leaflet's bundler-hostile default marker icon URLs and taking
  the site accent color.
- Dark mode inverts and hue-rotates the tile pane; markers sit in a pane above it.
- Positions are rounded to ~0.7 miles, which the page says plainly.

## Timeline

`/timeline` is one row per day merging seven streams: scrobbles, saved articles, books
started/finished, films watched, rides and lifts, published posts, photos taken. Nothing new is
stored — it fetches the same `/listening.json`, `/reading.json`, `/watching.json`, and
`/moving.json` bundles and merges them against build-time posts and photos
(`src/lib/timeline.ts`).

- **Depth is set by the listening days**, the densest stream and the only one worth a cursor.
  Everything else is filtered into that window; "load older" pulls another block. Once listening is
  exhausted the rest of the history shows — currently ~77 rows back to 2015.
- A day with no scrobbles still gets a row if anything else happened.
- **Photos appear from 2026 on** only, since placing one on a day needs a real capture date.
- **Films sit on their Letterboxd watched date**, which is a date and not a timestamp, so that
  stream needs no bucketing at all. Films imported from the CSV export are in here too, so the
  timeline reaches further back for watching than the 50-entry feed alone would allow.
- **Activities sit on their stored local date**, the one the Worker took from the API, so like
  films they need no bucketing.
- **Day bucketing is inherited from each stream, not recomputed** — the Worker groups scrobbles
  into US Central days while articles bucket in the viewer's zone, so the two disagree at the
  margins far from Central. See the note in `src/lib/datetime.ts`; it's a property of the data.

## Blog index

`/blog` is grouped into year sections; rows show month, day, and reading time (the `datetime`
attribute carries the full date; posts under 100 words show no estimate, same rule as the post
itself). The filter above matches title, summary, tag, or date — every whitespace-separated term
must match, so "music 2019" narrows.

Matching is a substring scan over a map built from the posts already on the page: ~35 posts needs
no index, no dependency, no fetch. With JavaScript off the input goes inert and the full list is
still there in the prerendered HTML.

## Colophon

`/colophon` prose lives in **`content/colophon.md`** — edit that, not the page component (`title`,
`lead`, `description` come from its frontmatter; same arrangement as `content/projects.md`).

Being a Markdown file in the repo, it gets what a post gets: a **Markdown** toggle above the body,
its source published at [`/colophon.md`](#markdown-source), and a [provenance](#provenance) line at
the foot reading its own commits out of `git log`.

Counters above it: posts, words, photos, and photo years are counted at build time; scrobbles,
books, articles, films, rewatches, miles, rides, and lifts are fetched from the Workers in the
browser. Each live tile renders only once its number lands, so a Worker being down costs those
tiles and nothing else. Twelve tiles in a three-column grid — the count and the columns have to
stay in step, or the last row goes ragged.

**Numbers in the prose** are substituted by `fillTemplate` in `src/lib/colophon.ts`. Two forms,
deliberately no more:

```markdown
{{photos}} photographs spanning {{years}} years…

{{#located}}
{{located}} of them carry a location…
{{/located}}
```

- Keys: `posts`, `words`, `photos`, `years`, `located`. Numbers are thousands-separated.
- `{{#key}}…{{/key}}` keeps its contents only when that count is non-zero, so "0 of them carry a
  location" never publishes.
- An unknown placeholder is **left in the text**, so a typo shows as `{{photoss}}` rather than
  silently deleting a sentence.
- Root-relative links render as client-side `<Link>`s.

Live numbers: scrobbles come from `/now.json` (Last.fm's own all-time total, no `COUNT(*)`) — the
field is optional in `NowState` so an older Worker reads as absent rather than zero. Books and
articles come from `/reading.json`. Photo counts are the length of `src/lib/photos.json`.

## Homepage

Static except for three things: the now-playing bar (polls `/now.json` every 60s), a 90-day
sparkline, and an "on this day" line from `/on-this-day.json`. A link to [/now](#now) sits under
the rotating identity line, since it answers the question that line raises. All three render nothing until their
fetch lands, and nothing at all if it fails. Under those, currently-reading, last-watched, and
last-moved strips, all from their Workers' `/now.json`. Below that, the four newest photographs,
labeled with capture day or year.

## Social cards

Every prerendered page gets a 1200×630 card at `/og/<path>.jpg`, written by
`scripts/generate-og.mjs` during `postbuild`.

```bash
npm run og                          # re-run against an existing dist/
npm run og -- --only /blog/…        # one page
npm run og -- --out .og-preview     # write somewhere safe to look at
```

- **Three layouts.** Pages with a photograph get it full-bleed under an ink scrim; `/terminal` gets
  its own dark screen, rendered as a session in JetBrains Mono; everything else gets the paper card
  — paper/ink palette, clay spine, title and description between hairlines. A page picks the
  terminal layout with `card={{ layout: 'terminal' }}`.
- **Copy comes from the built HTML** (`og:title`, `og:description`), so a card can't drift from its
  page. Page-only details (kicker, date, which photo) come through a `<meta name="og-card">` hint
  emitted by `<Seo card={{…}}>`.
- **Photographs are fetched from R2** at build time, falling back to `public/images`. A photo that
  can't be fetched falls back to the paper card rather than failing the deploy.
- **Type is Source Serif 4 + Inter** (+ JetBrains Mono, terminal card only), not the site's own
  fonts, which a Linux runner lacks. They ship as `.woff` in `node_modules`; satori converts glyphs
  to paths.
- Card paths are built in two places — `ogCardPath()` in `Seo.tsx` and `cardFile()` in the script.
  **They must agree** or pages point at a 404.

## RSS feed

`scripts/generate-rss.mjs` writes a full-content RSS 2.0 feed at `/feed.xml` during `postbuild`
(`npm run rss` re-runs it). Autodiscovery is in `index.html` on every page.

- **Item bodies are lifted from the prerendered HTML** (`<div class="post-body">`), not re-rendered
  from markdown, so the feed can't drift from the page.
- **Root-relative URLs are made absolute.** Post images are already absolute R2 URLs.
- **The 20 most recent posts** carry full text (`MAX_ITEMS`); older ones stay at `/blog`.
- **`lastBuildDate` is the newest post's date, not the build time** — every deploy rewrites the
  file, and a moving timestamp would keep claiming there's something new.

## Search (⌘K)

A command palette on every page — **⌘K** / **Ctrl-K**, **/** when not typing, or the header
magnifier. Jumps to any page, post, photo year, or tag.

- **The index is compiled in, not fetched.** The `cailinpitt:site-index` Vite plugin reads
  `content/blog/*.md` at build time and inlines path/title/date/tags as `virtual:site-index` — ~100
  bytes per post, no request. Bodies are never included. The same module carries photo years, plus
  (prerenderer only) every photo id; the browser build gets an empty list. It uses the site's own
  `src/lib/frontmatter.ts`, so it can't disagree with the rendered pages.
- Adding a post needs nothing here. Dev invalidates the module on changes under `content/blog/`.
- **Pages are listed by hand** in `PAGES` in `src/components/CommandPalette.tsx` — a new route
  needs adding there (years and tags are derived). `tests/command-palette.test.ts` holds the list
  against `App.tsx` in both directions.
- It's a native `<dialog>` opened with `showModal()`, so focus trapping and Escape come free.

## Terminal

`/terminal` is the site as a shell: `ls` the sections, `cat` a post or page, `open` a page, `now`,
`reading`, `guestbook`, `photo random`, `neofetch`. Tab completes, ↑/↓ walk history, Ctrl-L clears.

- **It's the whole viewport.** The route sits *outside* `<Layout>` in `App.tsx`, so there's no
  header or footer — `exit` (or any link in the output) is the way back. That's also why
  `tests/command-palette.test.ts` walks the route tree recursively instead of reading
  `routes[0].children`.
- **`src/lib/terminal.ts` is the engine and it's pure**: the tree, path resolution, completion, and
  every command. The outside world (navigation, theme, clock, fetchers) arrives as a `Shell`, so
  `tests/terminal.test.ts` runs it with no DOM and no network.
- **Nothing is a second source of truth.** Posts come from `virtual:site-index` (already in the
  bundle for ⌘K), `cat` fetches the published `.md` — of a post, or of `colophon`/`projects`, the
  two pages that are themselves one Markdown file — and `now`/`reading`/`guestbook` call the same
  clients the pages do.
- **Photo ids ride in the route loader**, since the browser build of `virtual:site-index`
  deliberately carries none.
- `COMMANDS` drives `help`, completion, and did-you-mean; a test asserts every name in it is
  actually handled.
- Signing the guestbook navigates to the real form rather than reimplementing a write path past
  Turnstile.
- Without JavaScript the prerendered HTML is a short list of real links, not an empty box.

## Header nav

Two rows: the title and the two icon buttons on one, the page links on another. The links are the
only part that grows, and they get a full-width row to wrap into, so adding a page never displaces
the buttons.

Two disclosures group the links that belong together: **Me** (`/about`, `/now`, `/uses` — pages
about the person rather than the work) and **Logs** (`/listening`, `/reading`, `/watching`,
`/moving` — the Worker-backed activity logs). "Logs" rather than something like "Doing" because it
is the word the rest of the site already uses — the homepage links read "Listening log →" — and
because it says why those four are grouped and Projects and Blog aren't. Grouping them is also what keeps the row
from growing a link every time a new one is added.

Each is a `<details>`/`<summary>`, so it opens with no JavaScript at all, which matters because the
nav is in the prerendered HTML of every page. `<summary>` also brings the button role, the
expanded/collapsed announcement, and keyboard activation. `src/components/NavMenu.tsx` adds only
what a dropdown is expected to do beyond that: close on navigation (a link click inside a
`<details>` navigates but leaves the panel hanging open), on Escape, and on a click elsewhere. The
summary carries `aria-current="page"` when any of its own pages is the one being viewed, so the
section reads as active even though the page is a level down.

## Color theme

Light/dark follows `prefers-color-scheme`; the header toggle cycles System → Light → Dark, stores
the choice in `localStorage`, and applies `data-theme` on `<html>`. An inline script in
`index.html` applies a stored choice before first paint.

Two media-scoped `<meta name="theme-color">` tags match the **page background**, not the accent, so
browser chrome reads as an extension of the paper. A media query can't see a manual override, so
`ThemeToggle` rewrites both tags with the resolved `--bg` when a theme is forced. The value is read
from the stylesheet rather than duplicated in JS, which is why it happens after mount — in the
pre-paint script the CSS isn't loaded and `--bg` reads empty. Cost: an overridden theme keeps the
media-matched tint for the first few frames.

## Publishing a photo from your phone

```
Shortcut → POST photos.cailinpitt.com/ingest → R2 (private originals bucket)
        → repository_dispatch → .github/workflows/ingest-photos.yml → commit → deploy
```

- **`worker-photos/` is deliberately thin**: authenticate, check the file, store it, fire a
  dispatch. It accepts the photo as a multipart `photo` field or as the raw body, and reads alt text and date from form fields, `X-Photo-*`
  headers, or the query string. It can't do more — renditions need `sharp`, which doesn't run in a
  Worker, and the manifest is a file in git.
- **The build runs the ordinary pipeline.** `scripts/ingest-photos.mjs --fetch` pulls pending
  uploads into `originals/<year>/`, then it's `images:sync` → `images:upload` → `--finish`. There
  is no second code path that publishes a photo, only a second way of getting files into
  `originals/`. `--finish` applies the Shortcut's alt text, archives the original, clears the queue.
- **Publishing takes a deploy, not a second.** In exchange a phone photo is the same kind of photo
  as any other: prerendered, permalinked, with a social card.
- **The URL is known before the build starts** — the Worker mints the filename and ids are
  `<year>-<filename>`, so `/ingest` returns the finished permalink for the notification.
- **Originals go to a private bucket** (`cailinpitt-photo-originals`), never the public one, since
  they carry full-precision GPS. Pull them back with `npm run photos:pull`.
- **A lost dispatch loses nothing** — the workflow also runs hourly.
- Setup, API, and the Shortcut recipe: [`worker-photos/README.md`](worker-photos/README.md)

## Tests

`npm test` (vitest, no config file — it picks up `vite.config.ts`, so `virtual:site-index` and
`import.meta.glob` resolve as they do in a build). Everything is in `tests/`, runs in under a
second, and touches no network, no `dist/`, and no images.

**A test has to pass on a fresh clone.** `public/images/` and `originals/` are gitignored, so CI
has no photographs — which is why `npm run images:check` is *not* in the workflow. It would report
every blog image as missing. Run it locally.

| Test | Guards against |
|---|---|
| `frontmatter`, `posts`, `tags`, `colophon` | Silent failures in the pure functions: a tag slug that stops collapsing casing splits one tag into two pages; a broken `{{#located}}` publishes "0 of them carry a location"; a word counter that counts iframes calls a photo essay a 12 minute read |
| `content` | Frontmatter facts the build trusts: duplicate `path` (posts prerender over each other), a `path` whose date disagrees with `date:`, a mistyped `tags:` arriving as a string. Padding-agnostic, since one post is at `/blog/2026/8/01/…` |
| `guestbook-validate` | The one piece of code deciding what a stranger may store. Lives in `worker-guestbook/`, which has no test setup, but it's pure |
| `command-palette` | The hand-written page list vs. the router, both directions |
| `photos` | The two rules the feed can't get wrong: ids are permanent public URLs (slugging + collision suffix pinned), and order is year then date. Tests `scripts/photo-manifest.mjs` against the site's own sort and checks they agree. Also pins what `photos:rm` considers part of a photo |

CI runs `typecheck` → `test` → `build`, so a broken invariant stops the deploy.

## Deploy

Push to `main` → `.github/workflows/deploy.yml` builds and publishes to GitHub Pages. Repo settings
need **Settings → Pages → Source = GitHub Actions**; the custom domain comes from `public/CNAME`.

The six Workers deploy **separately** — a push to `main` never touches them:

```sh
cd worker-listening && npm run deploy  # listening.cailinpitt.com
cd worker-reading && npm run deploy    # reading.cailinpitt.com
cd worker-watching && npm run deploy   # watching.cailinpitt.com
cd worker-moving && npm run deploy     # moving.cailinpitt.com
cd worker-guestbook && npm run deploy  # guestbook.cailinpitt.com
cd worker-photos && npm run deploy     # photos.cailinpitt.com
```

`.github/workflows/ingest-photos.yml` commits photos sent from the phone and pushes to `main`,
triggering the deploy above.
