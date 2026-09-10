# Runbook

Every command in the repo, by task. The overview is in [`README.md`](README.md); per-feature
rationale is in [`docs/DESIGN.md`](docs/DESIGN.md) and the per-worker READMEs.

## Develop

```bash
npm install
npm run dev            # dev server
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run test:watch
npm run build          # prerender → dist/ (runs postbuild: sitemap, llms, md, rss, atproto, og)
npm run preview        # serve dist/
```

Point the site at local Workers:

```bash
VITE_LISTENING_API=http://localhost:8787 npm run dev
VITE_READING_API=http://localhost:8787 npm run dev
VITE_WATCHING_API=http://localhost:8787 npm run dev
VITE_GUESTBOOK_API=http://localhost:8787 npm run dev
VITE_NOTES_API=http://localhost:8787 npm run dev
```

## Publish a blog post

```bash
npm run blog:draft -- <slug>      # 1. scaffold content/blog/<slug>.md with its frontmatter block
# 2. drop image originals in originals/<slug>/, reference them as /images/<slug>/<name>.webp
npm run dev                        # 3. preview

npm run blog:post -- <slug>        # 4. images → R2, atproto records, stages the files
git commit && git push            # 5. deploys
```

`npm run blog:draft` prompts for the title, description, tags, and cover image (slug can be passed or
prompted); everything but the slug has a default and can be left blank. It fills `date`/`path` from
today and writes `title, date, path, slug, tags, description, image`.

`npm run blog:post` with no slug picks up the single added/changed post under `content/blog`. It runs
`images:sync` + `images:upload`, then `publish:atproto`, then `git add`s `content/blog`,
`content/atproto.json`, `src/lib/photos.json`. It stops before commit.

```bash
npm run blog:post -- <slug> --dry-run       # preview every step, stage nothing
npm run blog:post -- <slug> --skip-images   # or --skip-atproto
```

## Photos

**Add:**

```bash
# drop camera files in originals/<year>/   (four-digit folder = photo, not blog image)
npm run images:publish             # images:sync + images:upload
git add src/lib/photos.json && git commit && git push
```

**Remove:**

```bash
npm run photos:rm -- <id>                  # e.g. 2026-img-1919
npm run photos:rm -- <id> --dry-run
npm run photos:rm -- https://cailinpitt.com/photos/<id>
npm run photos:rm -- <id> <id> <id>
# then commit src/lib/photos.json
```

**Maintenance:**

```bash
npm run images:sync                    # rebuild renditions + manifest from disk
npm run images:sync -- --prune         # drop manifest entries whose file is gone
npm run images:sync -- --reexif        # re-read EXIF from originals
npm run images:sync -- --retint        # recompute every tile's placeholder color
npm run images:sync -- --reencode      # rebuild every rendition
npm run images:check                   # report only; non-zero exit if out of date (local only, not CI)
npm run images:upload                  # push renditions to R2
npm run images:upload -- --dry-run
npm run images:prune                   # list unreferenced R2 objects
npm run images:prune -- --delete       # delete them
npm run images:prune -- --prefix <p>   # limit to a key prefix
npm run photos:backfill                # recover pre-2026 dates from the Squarespace export
npm run photos:backfill -- --dry-run
npm run photos:pull                    # pull archived originals out of the private bucket
npm run photos:pull -- --dry-run
```

**Drive a phone upload by hand** (instead of waiting for the dispatch):

```bash
node scripts/ingest-photos.mjs --fetch     # pending uploads → originals/<year>/
npm run images:sync
npm run images:upload
node scripts/ingest-photos.mjs --finish    # apply alt text, archive original, clear queue
```

## Regenerate build artifacts

Against an existing `dist/`, without a full rebuild:

```bash
npm run og                          # all social cards
npm run og -- --only /blog/<path>   # one page
npm run og -- --out .og-preview     # write somewhere safe to look at
npm run rss                         # feed.xml
npm run md                          # post sources → dist/<post path>.md
```

## Deploy

Push to `main`:

- The site builds and publishes to GitHub Pages (`deploy.yml`).
- Every `worker-*/` that changed in the push is deployed by `deploy-workers.yml` — `wrangler deploy`
  only, no D1 schema. Force one (or all) from the Actions tab → "Deploy workers" → Run workflow.

Manual fallback, from a `worker-*/` directory:

```bash
npm run deploy
```

D1 schema is never applied automatically — see the per-feature sections below.

### deploy-workers.yml setup (one time)

Add two repo secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` — dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template,
  Account Resources = your account, Zone Resources = `cailinpitt.com`.

## Workers — common

From any `worker-*/` directory:

```bash
npm run dev             # local
npm run deploy
npm run typecheck
npm run types           # regenerate worker-configuration.d.ts
npm run schema:local    # apply schema.sql to local D1
npm run schema:remote   # apply schema.sql to remote D1
npx wrangler tail       # live logs
npx wrangler secret put <NAME>
npx wrangler secret list
```

`worker-reading` and `worker-photos` also have `npm run dev:remote` (real D1/R2; needs one prior
deploy so the custom domain exists).

### D1 usage — staying under the free tier

Free tier is 5M rows read/day and **100k rows written/day**, per account (all databases
combined). "Rows written" counts index entries too, so a row in a table with four indexes is
~5 writes. Watch anything on a cron that rewrites rows unconditionally.

```bash
cd <worker-dir>
npx wrangler d1 insights <db-name> --sort-by writes --limit 10   # per-query write attribution, last 1d
npx wrangler d1 insights <db-name> --sort-by reads  --limit 10
```

The dashboard (D1 → each database → Metrics) shows the daily totals and which database they came
from. Steady state is near zero writes on every database — a write means someone signed the
guestbook, saved an article, or a sync picked something up.

## Listening

### One-time migration for the period views (do this in order)

The summary tables must exist **before** the new Worker ships — every ingest tick writes to them.
Deploying first doesn't lose scrobbles (the tick catches its own errors) but logs a failure every
minute until the tables land.

```bash
cd worker-listening
# 1. create the Layer 1 tables
wrangler d1 execute cailinpitt-listening --remote --file=schema-v2.sql
# 2. populate them from the existing archive (~400k row reads, one time)
wrangler d1 execute cailinpitt-listening --remote --file=backfill-summary.sql
# 3. now deploy the Worker that maintains them
npm run deploy
```

Step 2 writes absolute values (`plays = COUNT(*)`), so it's safe to re-run if interrupted. It must
not race a *running* new Worker, though — the tick increments these counters, so run it before the
deploy, not after.

After deploying, the cron backfills period blobs: years first, then months, then weeks, one every
three minutes. All ~356 periods finish inside a day; `/listening/<year>` pages work within about
twenty minutes. Watch it with:

```bash
curl -s https://listening.cailinpitt.com/periods.json | python3 -m json.tool | head
```

Until a period is built, its page says so rather than erroring.

### Genres and listening time (Tier B / C)

Same rule as before: tables first, then deploy.

```bash
cd worker-listening
wrangler d1 execute cailinpitt-listening --remote --file=schema-v3.sql
npm run deploy
```

The cron enriches two entities a minute — about nine days to work through 4,340 artists and 8,854
albums. The backfill does it in roughly an hour instead:

```bash
node scripts/enrich-listening.mjs            # ~1 hour, resumable
cd worker-listening
wrangler d1 execute cailinpitt-listening --remote --file=../scripts/enrich.sql
```

`enrich.sql` is large — roughly 7 MB and ~31,000 statements, because unlike `backfill.sql` (which
packs 100 rows per `INSERT`) this writes one upsert per entity. If `wrangler` times out or rejects
the file, split it and load in chunks — every statement is an idempotent upsert, so a failed chunk
can be re-run:

```bash
cd /tmp && rm -rf d1chunks && mkdir d1chunks
split -l 2000 ~/Development/cailinpitt.com/scripts/enrich.sql d1chunks/part_
cd ~/Development/cailinpitt.com/worker-listening
for f in /tmp/d1chunks/part_*; do
  echo "→ $f"
  wrangler d1 execute cailinpitt-listening --remote --file="$f" || break
done
```

The row-write total (~31k) is well inside D1's 100k writes/day free-tier cap.

Durations come from `album.getInfo`, which returns the whole tracklist per call — 8,854 album
lookups cover all 18,114 tracks.

Genre stats read an artist→genre blob rebuilt daily, so genres appear on periods built from the next
rebuild onward. To force it sooner, delete `meta:v1:built-at` from KV.

**Editing the taxonomy** in `worker-listening/src/genres.ts` is expected. Raw tags are stored, not
canonical genres, so a change needs no re-fetching. But completed period blobs are frozen, so after
editing you must bump `PREFIX` in `src/period.ts` (`p:v2:` → `p:v3:`) and redeploy — the prefix is
part of the edge cache key too, so this invalidates both KV and the edge; the backfill walk then
rebuilds every period under the new prefix within a day. Old keys are orphaned and only cost KV
storage.

### Artist origin and era (Tier D)

```bash
cd worker-listening
wrangler d1 execute cailinpitt-listening --remote --file=schema-v4.sql
npm run deploy

node ../scripts/musicbrainz-listening.mjs      # ~75 min, resumable
wrangler d1 execute cailinpitt-listening --remote --file=../scripts/musicbrainz.sql
```

`schema-v4.sql` is `ALTER TABLE ... ADD COLUMN`, which SQLite can't make conditional — re-running it
errors on the second pass. Harmless.

MusicBrainz caps at one request per second, hence the runtime. Accuracy comes from Last.fm's
`artist.getInfo` MBID, which turns a fuzzy name search into an exact lookup; across the top artists
here the two methods never disagreed.

**Reviewing the fuzzy matches.** `node scripts/review-origins.mjs` ranks by play count and hides
everything under 0.1% of the archive. `--verify 20` then asks MusicBrainz which of the top names are
shared by more than one act — the `score` column in the review file doesn't tell you this, since
MusicBrainz returns 100 for any exact name match.

```bash
node scripts/review-origins.mjs             # ranked by plays
node scripts/review-origins.mjs --verify 20 # + name-collision check, after the backfill
```

Artists resolved by name search — the only ones that can be *wrong* — are listed in
`scripts/musicbrainz.review.txt`. Failure mode: a name shared by two acts (Last.fm resolves
"Turnstile" to a Spanish group rather than the Baltimore band). Correct any in `ORIGIN_OVERRIDES`
(`worker-listening/src/musicbrainz.ts`), applied when the lookup blob is built, so a correction
needs no re-fetch — redeploy, then delete `meta:v1:built-at` from KV to rebuild immediately.

**Era is groups only.** MusicBrainz's `life-span.begin` is a formation year for a band but a
*birth* year for a person, so solo artists are excluded from the era chart.

### Returning artists

```bash
cd worker-listening
wrangler d1 execute cailinpitt-listening --remote --file=schema-v5.sql
wrangler d1 execute cailinpitt-listening --remote --file=backfill-returns.sql
npm run deploy
```

The backfill is one `LAG()` pass over the archive (~101k rows, once). After it, ingest maintains the
table incrementally: each tick reads the artists' previous `last_uts` *before* the summary upsert
overwrites it — the only moment the gap is visible.

The 365-day threshold lives in two places that must agree — `RETURN_GAP` in `src/summary.ts` and the
`WHERE` clause in `backfill-returns.sql`. Changing one means re-running the backfill.

### Baking periods into the build

Completed periods are fetched at build time into `public/listening-data/` to serve as static assets
instead of Worker requests. Runs automatically as `prebuild` and never fails a build — an
unreachable Worker means the client fetches at runtime instead.

```bash
npm run listening:bake                 # refresh the local copy by hand
LISTENING_API=http://127.0.0.1:8787 npm run listening:bake
```

### Everything else

```bash
# backfill full scrobble history (repo root; needs LASTFM_API_KEY)
node scripts/backfill-listening.mjs
cd worker-listening
wrangler d1 execute cailinpitt-listening --remote --file=../scripts/backfill.sql

# terminal view
curl listening.cailinpitt.com
curl listening.cailinpitt.com?T        # no color
curl listening.cailinpitt.com?w=30d
```

Inspect D1:

```bash
npx wrangler d1 execute cailinpitt-listening --remote \
  --command "SELECT COUNT(*) FROM scrobbles"
```

## Reading

```bash
npm run reading:probe                  # check the Hardcover query, no deploy needed
npm run reading:probe -- --json
npm run reading:sync                   # run the Hardcover sync now
npm run reading:sync -- --covers       # loop until covers stop mirroring
npm run reading:split-links            # dump articles to a review file (see "Splitting links out")
npm run reading:split-links -- --apply # move the rows you marked `link`
```

### One-time migration: fingerprint the sync (do this before deploying)

`stats.library_hash` gates the wholesale `books` rebuild — without it an ingest
tick reads a missing column and the whole sync fails. Apply it first, same as the
listening migration:

```bash
cd worker-reading
npx wrangler d1 execute cailinpitt-reading --remote --file=schema-v3.sql
# then deploy the Worker
```

The hourly cron pulls the whole library every run, but the rebuild (DELETE +
re-insert of ~400 rows, each hitting several indexes) runs only when a SHA-256 of
the pulled library changes — books change a few times a week, so this takes the
worker from ~100k D1 row-writes/day to near zero. The totals row is still
refreshed at least once a day so a manual edit to `books` reconciles.
`schema-v3.sql` also drops `idx_books_status`, which `idx_books_read_seq` already
covered.

### One-time migration: the `links` table (do this before deploying)

`schema-v6.sql` adds the `links` table and `stats.links`. A bundle build or an ingest tick that
hits the missing table/column fails, so apply it first — same rule as v3/v4:

```bash
cd worker-reading
npx wrangler d1 execute cailinpitt-reading --remote --file=schema-v6.sql
# then deploy the Worker
```

Save / annotate / remove / move an article or a link:

```bash
curl -sX POST https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/x","note":"optional"}'          # → articles

curl -sX POST https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://opusfived.dev/","kind":"link"}'             # → links (moves if already an article)

curl -sX PATCH https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/x","note":"more","append":true}'

curl -sX PATCH https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/x","kind":"article"}'           # move a link back

curl -sX DELETE https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/x"}'
```

### Splitting links out of articles

```bash
npm run reading:split-links             # writes scripts/.reading-split.tsv, one row per article
#   edit column 1 (link | article) by hand
npm run reading:split-links -- --apply  # POSTs each `link` row with kind:"link" — the Worker moves it
```

Idempotent; the next hourly sync reconciles `stats.articles` / `stats.links`.

Inspect D1:

```bash
npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT COUNT(*) AS rows, SUM(cover IS NOT NULL) AS with_cover FROM books"
npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT url, title, note, read_at FROM articles ORDER BY read_at DESC LIMIT 5"
npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT url, title, note, saved_at FROM links ORDER BY saved_at DESC LIMIT 5"
```

```bash
curl reading.cailinpitt.com            # terminal view; ?T for no color
```

## Watching

```bash
npm run watching:sync                  # pull the Letterboxd diary feed now
npm run watching:sync -- --posters     # loop until posters stop mirroring
npm run watching:sync -- --recompute   # rebuild the totals from the archive, no feed call
```

The hourly cron re-offers the feed's whole 50-entry window every run. Each write
is a guarded upsert (`… ON CONFLICT DO UPDATE … WHERE <any column differs>`), so a
quiet run writes nothing and the totals are recomputed only when a row moved — no
schema change, just deploy. Use `--recompute` after a bulk load, which the
`changed > 0` guard can't see.

Import the history behind the feed's 50-entry window (letterboxd.com/settings/data → export):

```bash
node scripts/watching-backfill.mjs ~/Downloads/letterboxd-export/diary.csv
cd worker-watching && npx wrangler d1 execute cailinpitt-watching \
  --remote --file=../scripts/watching-backfill.sql
cd .. && npm run watching:sync -- --recompute   # rebuild the totals in `stats`
```

The script resolves every `boxd.it` short link in the export to its real film slug and caches the
results in `scripts/.watching-slugs.json`; delete that file to force a re-resolve. It and the
generated `.sql` are gitignored.

Inspect D1:

```bash
npx wrangler d1 execute cailinpitt-watching --remote \
  --command "SELECT COUNT(*) AS rows, SUM(poster IS NOT NULL) AS with_poster FROM films"
npx wrangler d1 execute cailinpitt-watching --remote \
  --command "SELECT title, watched_date, rating FROM films ORDER BY watched_date DESC LIMIT 5"
```

Duplicate rows mean a backfill ran with guessed slugs — check for them before trusting the totals:

```bash
npx wrangler d1 execute cailinpitt-watching --remote \
  --command "SELECT title, watched_date, COUNT(*) n FROM films GROUP BY lower(title), watched_date HAVING n > 1"
```

Starting the archive over is safe — everything is re-derivable from the feed plus the CSV:

```bash
npx wrangler d1 execute cailinpitt-watching --remote --command "DROP TABLE films"
npm run schema:remote                  # from worker-watching/
```

```bash
curl watching.cailinpitt.com           # terminal view; ?T for no color
```

## Concerts

No Worker or D1, backed by JSON:

```bash
node scripts/concerts-import.mjs ~/Downloads/"<name> - Concert Archives Export - <date>.csv"
git add src/lib/concerts.json && git commit -m "concerts: import"
```

Safe to re-run against any export including the same one twice, because concerts are merged by id.

## Moving

```bash
npm run moving:sync                    # pull the last week now
npm run moving:sync -- --refresh       # re-pull everything already stored
npm run moving:sync -- --backfill      # walk backwards through history via the API
npm run moving:auth                    # one-time OAuth, prints a refresh token
```

Adding heart rate to an existing database (once, before deploying the Worker that
reads it):

```bash
cd worker-moving && npx wrangler d1 execute cailinpitt-moving \
  --remote --file=schema-v2.sql
cd .. && npm run moving:sync -- --refresh   # fill in history; ~12 API requests
```

`schema.sql` is `CREATE TABLE IF NOT EXISTS`, so it can't add a column to a table that already
exists. Re-running `schema-v2.sql` fails with "duplicate column name", meaning it was already
applied. `--refresh` backfills the archive; the incremental sync only rewrites the last week.

Import history from the bulk export (strava.com/settings/privacy → request an archive):

```bash
node scripts/moving-backfill.mjs ~/Downloads/export_XXXXXXXX/activities.csv
cd worker-moving && npx wrangler d1 execute cailinpitt-moving \
  --remote --file=../scripts/moving-backfill.sql
cd .. && npm run moving:sync -- --refresh   # fix dates, recompute `stats`
```

`--refresh` is required: the export carries no local timestamp, so the generated SQL dates every
activity with a fixed Central offset — only the API knows which day a ride actually belongs to. The
generated `.sql` is gitignored.

After changing the `kind` mapping in `worker-moving/src/strava.ts`, re-derive the stored column —
the sync only rewrites rows it fetched, so older rows keep the old bucket:

```bash
cd worker-moving && npx wrangler d1 execute cailinpitt-moving \
  --remote --file=../scripts/moving-recategorize.sql
cd .. && npm run moving:sync           # recompute `stats`
```

Inspect D1:

```bash
npx wrangler d1 execute cailinpitt-moving --remote \
  --command "SELECT kind, COUNT(*) n FROM activities GROUP BY kind ORDER BY n DESC"
npx wrangler d1 execute cailinpitt-moving --remote \
  --command "SELECT start_date, kind, distance_mi FROM activities ORDER BY start_date DESC LIMIT 5"
```

Dates look a day off? That's the export's UTC bucketing. Compare against the real timestamp:

```bash
npx wrangler d1 execute cailinpitt-moving --remote \
  --command "SELECT start_date, datetime(started_at,'unixepoch') utc FROM activities ORDER BY started_at DESC LIMIT 10"
```

Starting the archive over is safe — everything is re-derivable from the API plus the export:

```bash
npx wrangler d1 execute cailinpitt-moving --remote --command "DROP TABLE activities"
npm run schema:remote                  # from worker-moving/
```

Dropping the whole database rather than the table also drops the `auth` row; the refresh token then
has to be re-seeded from `STRAVA_REFRESH_TOKEN`.

```bash
curl moving.cailinpitt.com             # terminal view; ?T for no color
```

## Notes (the microblog)

Publishing is a page, not a command: **<https://cailinpitt.com/notes/compose>** on a computer, or
the iOS Shortcut on a phone (recipe in [`worker-notes/README.md`](worker-notes/README.md)). Both
need the `PUBLISH_TOKEN`; the compose page asks once per device.

From a terminal:

```bash
TOKEN=…   # the Worker's PUBLISH_TOKEN

# publish
curl -X POST https://notes.cailinpitt.com/notes \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"trains are good, actually"}'

# edit (stamps edited_at; the site shows an "edited" marker)
curl -X PATCH https://notes.cailinpitt.com/notes/<id> \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"the corrected thought"}'

# delete — immediate and permanent
curl -X DELETE https://notes.cailinpitt.com/notes/<id> -H "authorization: Bearer $TOKEN"

# read
curl notes.cailinpitt.com                  # terminal view
curl notes.cailinpitt.com?T                # …without color
curl notes.cailinpitt.com/notes.json
curl notes.cailinpitt.com/feed.xml         # RSS (separate from the site's /feed.xml)
```

First-time setup:

```bash
cd worker-notes
npm install
wrangler d1 create cailinpitt-notes        # paste the id into wrangler.jsonc
npm run schema:remote
wrangler secret put PUBLISH_TOKEN          # openssl rand -hex 32
npm run deploy
```

Rotating `PUBLISH_TOKEN` signs out every device; use it to revoke a lost phone.

## Guestbook — moderation

```bash
npm run guestbook:list                    # 50 newest, with ids
npm run guestbook:list -- --limit 200
npm run guestbook:rm -- <id> [<id> ...]   # immediate and permanent
curl guestbook.cailinpitt.com             # terminal view
```

Needs `GUESTBOOK_ADMIN_TOKEN` in `.env`, matching the Worker's `ADMIN_TOKEN`.

## Comments — moderation

```bash
npm run comments:list                    # 50 newest, with ids and post paths
npm run comments:list -- --limit 200
npm run comments:rm -- <id> [<id> ...]   # immediate and permanent
```

Needs `COMMENTS_ADMIN_TOKEN` in `.env`, matching the Worker's `ADMIN_TOKEN`.

## Credentials

`.env` at the repo root (gitignored):

| Key | Used by |
|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | all R2 scripts |
| `R2_BUCKET` (public), `R2_ORIGINALS_BUCKET` (private) | `images:*`, `photos:pull`, `photos:rm` |
| `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD` (+ optional `BLUESKY_PDS`) | `publish:atproto` |
| `LASTFM_API_KEY`, `LASTFM_USER` | `backfill-listening.mjs` |
| `HARDCOVER_TOKEN` | `reading:probe` |
| `READING_ADMIN_TOKEN` | `reading:sync` |
| `WATCHING_ADMIN_TOKEN` | `watching:sync` |
| `MOVING_ADMIN_TOKEN` | `moving:sync` |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN` | `moving:auth` |
| `INGEST_TOKEN` | saving articles & links, `reading:split-links` |
| `GUESTBOOK_ADMIN_TOKEN`, `GUESTBOOK_IP_SALT` | `guestbook:list` / `rm` |
| `COMMENTS_ADMIN_TOKEN`, `COMMENTS_IP_SALT` | `comments:list` / `rm` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | guestbook and comment forms (same widget) |
| `WORKER_PHOTOS_INGEST_TOKEN`, `WORKER_PHOTOS_GITHUB_TOKEN` | phone uploads |
| `NOTES_PUBLISH_TOKEN` | notes — the Worker's `PUBLISH_TOKEN`, kept here as the copy of record |

Overrides for pointing a script at a non-default Worker: `READING_API`, `WATCHING_API`,
`MOVING_API`, `GUESTBOOK_API`, `COMMENTS_API`, or `--api <url>` on `reading:sync` /
`watching:sync` / `moving:sync` / `guestbook:list` / `guestbook:rm` / `comments:list` /
`comments:rm`.

Worker secrets (`npx wrangler secret put`, per directory):

| Worker | Secrets |
|---|---|
| `worker-listening` | `LASTFM_API_KEY` |
| `worker-reading` | `HARDCOVER_TOKEN`, `INGEST_TOKEN`, `ADMIN_TOKEN` |
| `worker-watching` | `ADMIN_TOKEN` |
| `worker-moving` | `ADMIN_TOKEN`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN` |
| `worker-guestbook` | `TURNSTILE_SECRET`, `ADMIN_TOKEN`, `IP_SALT` |
| `worker-comments` | `TURNSTILE_SECRET`, `ADMIN_TOKEN`, `IP_SALT` |
| `worker-photos` | `INGEST_TOKEN`, `GITHUB_TOKEN` |

GitHub Actions secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
`R2_ORIGINALS_BUCKET` (`ingest-photos.yml`, `note-og.yml`); `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` (`deploy-workers.yml`).

Cloudflare secrets are write-only — `.env` is the only place a token can be read back from.

## Build-time env vars

| Var | Default |
|---|---|
| `VITE_LISTENING_API` | `https://listening.cailinpitt.com` |
| `VITE_READING_API` | `https://reading.cailinpitt.com` |
| `VITE_WATCHING_API` | `https://watching.cailinpitt.com` |
| `VITE_MOVING_API` | `https://moving.cailinpitt.com` |
| `VITE_GUESTBOOK_API` | `https://guestbook.cailinpitt.com` |
| `VITE_COMMENTS_API` | `https://comments.cailinpitt.com` |

## First-time setup

Per-worker setup (create D1/KV/R2, apply schema, put secrets) is in each worker's README:
[listening](worker-listening/README.md#setup) ·
[reading](worker-reading/README.md#setup) ·
[watching](worker-watching/README.md#setup) ·
[moving](worker-moving/README.md#setup) ·
[guestbook](worker-guestbook/README.md#setup) ·
[photos](worker-photos/README.md#setup) ·
[comments](worker-comments/README.md#setup)

Concerts needs none of that — `src/lib/concerts.json` ships in the repo.

Repo settings: **Settings → Pages → Source = GitHub Actions**. Custom domain from `public/CNAME`.

## Migration scripts (historical)

```bash
npm run migrate:posts     # squarespace-export.xml → content/blog/*.md
npm run migrate:images    # pull images off the Squarespace CDN
```
