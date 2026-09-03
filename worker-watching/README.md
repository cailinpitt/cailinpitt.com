# worker-watching

The API behind [cailinpitt.com/watching](https://cailinpitt.com/watching). Films come from the
Letterboxd diary RSS feed; D1 stores them, R2 holds mirrored poster art, and an hourly cron pulls
the feed.

Sibling of `worker-reading`, deliberately shaped like it — same CORS rules, same edge-cached
bundle, same `curl` text view, same admin-token `/sync`.

## Why RSS

**Letterboxd has no public API** (still request-only beta at api@letterboxd.com), but every
member profile publishes an RSS feed, and for a diary that feed carries rating, watched date,
rewatch flag, TMDB id, and poster in *named* fields. Nothing in `src/letterboxd.ts` depends on
markup, so this isn't scraping and a site redesign can't break it. Two consequences:

- The feed is a **50-entry window** — why every write is an upsert (`schema.sql`) and why history
  behind it needs a one-time CSV import (see "Backfill").
- Letterboxd **403s requests that don't look like a browser**. The `user-agent` in `fetchDiary()`
  is load-bearing. If Letterboxd ever blocks Cloudflare egress by IP, `/sync` fails with a
  `FeedError`; the fix is moving that fetch into a GitHub Action and POSTing parsed entries in —
  the storage half needs no changes.

Television is deliberately absent — no free way to get it: Hulu and Max publish no history, Simkl
says as much outright, Trakt's Streaming Scrobbler is paid, and Trakt has since moved API
application creation behind VIP too.

## Setup

```sh
npm install

# 1. Database (already created; the id is in wrangler.jsonc)
npm run schema:remote

# 2. Secret
npx wrangler secret put ADMIN_TOKEN     # openssl rand -hex 24

# 3. Deploy (creates watching.cailinpitt.com and its cert)
npm run deploy
```

`LETTERBOXD_USER` is a plain var in `wrangler.jsonc`, not a secret — it's half of a URL anyone can
open.

Put the same `ADMIN_TOKEN` in the site's `.env` as `WATCHING_ADMIN_TOKEN` — Cloudflare secrets are
write-only, and that file is the only place to read it back.

To start the database over (it holds nothing that isn't re-derivable):

```sh
npx wrangler d1 delete cailinpitt-watching
npx wrangler d1 create cailinpitt-watching   # paste the new id into wrangler.jsonc
npm run schema:remote
```

## Backfill

The first sync only sees the newest 50 diary entries. To import everything behind that:

```sh
# letterboxd.com/settings/data → export → unzip
node scripts/watching-backfill.mjs ~/Downloads/letterboxd-export/diary.csv
npx wrangler d1 execute cailinpitt-watching --remote \
  --file=../scripts/watching-backfill.sql

# then mirror the poster art the feed did bring, a budget at a time
npm run watching:sync -- --posters
```

Backfilled films have no poster and no TMDB id — Letterboxd's CSV export omits both, unlike its
RSS feed. Those cards render the placeholder with no data to fix it from.

## Endpoints

| Path | What |
| --- | --- |
| `GET /watching.json` | The bundle: first page of films, plus totals |
| `GET /films?cursor=&limit=` | Older films, newest first |
| `GET /now.json` | The last film logged, for the terminal |
| `GET /` with a CLI user-agent | The text view (`curl watching.cailinpitt.com`) |
| `POST /sync` | Runs the pull. Needs `Authorization: Bearer $ADMIN_TOKEN` |

## Notes on the data

- **Film ids are `<slug>|<watched date>`, not the feed's guid.** A diary entry logged without a
  review arrives as `letterboxd-watch-N` and comes back as `letterboxd-review-M` if a review is
  added later; keying on the guid would file the same viewing twice. Cost: two viewings of one
  film on one day collapse into one row.
- **Rows are `INSERT OR REPLACE`.** A rating or review added later is an edit to a stored entry;
  the feed is authoritative on every column.
- **Ratings keep their halves.** Unlike the book shelf, which rounds, 3½ and 4 mean different
  things on Letterboxd and the page shows both.
- **Reviews and diary permalinks aren't stored.** The feed carries both; the page shows ratings
  only, and cards link to `letterboxd.com/film/<slug>` — the film's public page — rather than the
  entry under `/<member>/`, which would put the account on every card.
- **`stats` is recomputed on every sync**, not incremented — the sync only sees the newest 50
  entries, so totals must come from the archive itself.
