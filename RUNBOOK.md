# Runbook

Every command in the repo, by task. Explanations live in [`README.md`](README.md) and the per-worker
READMEs.

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
```

## Publish a blog post

```bash
# 1. write content/blog/<slug>.md  (frontmatter: title, date, path, slug, tags, description, image)
# 2. inline images
mkdir -p originals/<slug>/         # drop originals here
npm run images:publish             # compress → public/images/<slug>/ + upload to R2
# reference in markdown as /images/<slug>/<name>.webp

npm run dev                        # 3. preview
npm run publish:atproto            # 4. Bluesky records; then commit content/atproto.json
git add content/blog/<slug>.md content/atproto.json && git commit && git push   # 5. deploys
```

```bash
npm run publish:atproto -- --dry-run   # no login, no writes
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

```bash
git push                               # main → GitHub Pages (site only)

cd worker-listening && npm run deploy   # listening.cailinpitt.com
cd worker-reading   && npm run deploy   # reading.cailinpitt.com
cd worker-watching  && npm run deploy   # watching.cailinpitt.com
cd worker-guestbook && npm run deploy   # guestbook.cailinpitt.com
cd worker-photos    && npm run deploy   # photos.cailinpitt.com
```

Workers are **not** part of the site pipeline — a push to `main` never touches them.

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

## Listening

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
```

Save / annotate / remove an article:

```bash
curl -sX POST https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/x","note":"optional"}'

curl -sX PATCH https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/x","note":"more","append":true}'

curl -sX DELETE https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/x"}'
```

Inspect D1:

```bash
npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT COUNT(*) AS rows, SUM(cover IS NOT NULL) AS with_cover FROM books"
npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT url, title, note, read_at FROM articles ORDER BY read_at DESC LIMIT 5"
```

```bash
curl reading.cailinpitt.com            # terminal view; ?T for no color
```

## Watching

```bash
npm run watching:sync                  # pull the Letterboxd diary feed now
npm run watching:sync -- --posters     # loop until posters stop mirroring
```

Import the history behind the feed's 50-entry window (letterboxd.com/settings/data → export):

```bash
node scripts/watching-backfill.mjs ~/Downloads/letterboxd-export/diary.csv
cd worker-watching && npx wrangler d1 execute cailinpitt-watching \
  --remote --file=../scripts/watching-backfill.sql
cd .. && npm run watching:sync         # recompute the totals in `stats`
```

The script resolves every `boxd.it` short link in the export to its real film slug and caches the
results in `scripts/.watching-slugs.json`; delete that file to force a re-resolve. Both it and the
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

## Guestbook — moderation

```bash
npm run guestbook:list                    # 50 newest, with ids
npm run guestbook:list -- --limit 200
npm run guestbook:rm -- <id> [<id> ...]   # immediate and permanent
curl guestbook.cailinpitt.com             # terminal view
```

Needs `GUESTBOOK_ADMIN_TOKEN` in `.env`, matching the Worker's `ADMIN_TOKEN`.

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
| `INGEST_TOKEN` | saving articles |
| `GUESTBOOK_ADMIN_TOKEN`, `GUESTBOOK_IP_SALT` | `guestbook:list` / `rm` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | guestbook form |
| `WORKER_PHOTOS_INGEST_TOKEN`, `WORKER_PHOTOS_GITHUB_TOKEN` | phone uploads |

Overrides for pointing a script at a non-default Worker: `READING_API`, `WATCHING_API`,
`GUESTBOOK_API`, or `--api <url>` on `reading:sync` / `watching:sync` / `guestbook:list` /
`guestbook:rm`.

Worker secrets (`npx wrangler secret put`, per directory):

| Worker | Secrets |
|---|---|
| `worker-listening` | `LASTFM_API_KEY` |
| `worker-reading` | `HARDCOVER_TOKEN`, `INGEST_TOKEN`, `ADMIN_TOKEN` |
| `worker-watching` | `ADMIN_TOKEN` |
| `worker-guestbook` | `TURNSTILE_SECRET`, `ADMIN_TOKEN`, `IP_SALT` |
| `worker-photos` | `INGEST_TOKEN`, `GITHUB_TOKEN` |

GitHub Actions secrets (for `ingest-photos.yml`): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ORIGINALS_BUCKET`.

Cloudflare secrets are write-only — `.env` is the only place a token can be read back from.

## Build-time env vars

| Var | Default |
|---|---|
| `VITE_LISTENING_API` | `https://listening.cailinpitt.com` |
| `VITE_READING_API` | `https://reading.cailinpitt.com` |
| `VITE_WATCHING_API` | `https://watching.cailinpitt.com` |
| `VITE_GUESTBOOK_API` | `https://guestbook.cailinpitt.com` |

## First-time setup

Per-worker setup (create D1/KV/R2, apply schema, put secrets) is in each worker's README:
[listening](worker-listening/README.md#setup) ·
[reading](worker-reading/README.md#setup) ·
[guestbook](worker-guestbook/README.md#setup) ·
[photos](worker-photos/README.md#setup)

Repo settings: **Settings → Pages → Source = GitHub Actions**. Custom domain from `public/CNAME`.

## Migration scripts (historical)

```bash
npm run migrate:posts     # squarespace-export.xml → content/blog/*.md
npm run migrate:images    # pull images off the Squarespace CDN
```
