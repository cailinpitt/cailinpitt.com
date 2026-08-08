# worker-moving

The API behind [cailinpitt.com/moving](https://cailinpitt.com/moving). Bike
rides and lifting sessions come from the Strava API; D1 stores them and a cron
every 30 minutes pulls anything new.

Sibling of `worker-watching`, and deliberately shaped like it — same CORS rules,
same edge-cached bundle, same `curl` text view, same admin-token `/sync`. No R2:
activities carry no art.

## Nothing user-facing names Strava

The page, the nav, the terminal view, and the row copy all avoid naming where
this comes from. That is a deliberate product decision, not an accident — keep
it in mind when editing `src/text.ts` or anything under `src/` in the site.
Comments and this file are implementation, and say Strava freely.

## Why the API, and what it costs

Strava restructured its developer program in June 2026: Standard Tier (≤10
athletes, which is this) now requires an active Strava subscription. There is no
free path to an automated feed — the bulk export is free but manual, and
downstream services that used to relay Strava data are now barred from serving
it. `intervals.icu`, for instance, returns a stub for every Strava-sourced
activity:

```json
{"id":"…","source":"STRAVA","_note":"STRAVA activities are not available via the API"}
```

Two limits worth knowing:

- **1,000 non-upload requests a day**, 100 per 15 minutes. A steady-state run
  spends one, so the 30-minute cron spends about 48 a day — the access token is
  cached in `auth`, so most runs skip the refresh. A full `--refresh` over
  ~2,200 activities spends about 12.
- **The refresh token rotates on every exchange.** It therefore cannot live in a
  Worker secret, which is write-only from the Worker's side — the `auth` table
  in D1 holds the current one and the secret only seeds the first run.

## Setup

```sh
npm install

# 1. Database (already created; the id is in wrangler.jsonc)
npm run schema:remote

# 2. Secrets
npx wrangler secret put ADMIN_TOKEN            # openssl rand -hex 24
npx wrangler secret put STRAVA_CLIENT_ID       # strava.com/settings/api
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_REFRESH_TOKEN   # npm run moving:auth

# 3. Deploy (creates moving.cailinpitt.com and its cert)
npm run deploy
```

`npm run moving:auth` (from the repo root) runs the one-time OAuth: it opens a
local server on port 8721 to catch the redirect, so set the Strava app's
"Authorization Callback Domain" to `localhost`. It asks for
`activity:read_all` — without it, private activities are invisible to the API
and would silently miss from the archive.

Put the same `ADMIN_TOKEN` in the site's `.env` as `MOVING_ADMIN_TOKEN`, since
Cloudflare secrets are write-only and that file is the only place you can read
it back from.

To start the database over (it holds nothing that isn't re-derivable):

```sh
npx wrangler d1 delete cailinpitt-moving
npx wrangler d1 create cailinpitt-moving   # paste the new id into wrangler.jsonc
npm run schema:remote
```

## Backfill

A cron run only looks at the last week. To import everything behind that, use
the bulk export rather than the API — it costs no requests and is already on
disk:

```sh
# strava.com/settings/privacy → request an archive → unzip
node scripts/moving-backfill.mjs ~/Downloads/export_XXXXXXXX/activities.csv
npx wrangler d1 execute cailinpitt-moving --remote \
  --file=../scripts/moving-backfill.sql

# then correct the dates the CSV could only approximate — see below
cd .. && npm run moving:sync -- --refresh
```

That last step is not optional. **The export carries no local timestamp**, only
UTC, so `moving-backfill.mjs` derives each calendar date with a fixed Central
offset — wrong across DST and anywhere but home. `--refresh` re-pulls every
stored activity and takes Strava's own per-activity local date, which is the
only authority on which day a ride belongs to.

`npm run moving:sync -- --backfill` walks the history through the API instead,
`PAGE_BUDGET` pages per pass. It exists as a fallback for when the export isn't
available; prefer the export.

## Endpoints

| Path | What |
| --- | --- |
| `GET /moving.json` | The bundle: first page of activities, plus the totals |
| `GET /activities?cursor=&limit=&kind=` | Older activities, newest first |
| `GET /now.json` | The last activity, for the terminal and the /now bar |
| `GET /` with a CLI user-agent | The text view (`curl moving.cailinpitt.com`) |
| `POST /sync` | Runs the pull. Needs `Authorization: Bearer $ADMIN_TOKEN` |

`/sync` takes `?backfill=1` to walk backwards into the archive, or
`?refresh=1&page=N` to re-pull history that is already stored.

## Notes on the data

- **Ids are Strava's own activity ids**, which is what makes the export and the
  API interchangeable: a row imported from the CSV and the same activity fetched
  later are the same row, so the two halves cannot duplicate each other.
- **Rows are `INSERT OR REPLACE`** from the API and `INSERT OR IGNORE` from the
  backfill, so the live API always wins over the older snapshot.
- **`kind` is derived from `sport_type`**, not stored by Strava: ride, ebike,
  lift, walk, run, yoga, climb, other. E-bikes are split from ordinary rides
  because they are different efforts and the page labels them differently.
  After changing that mapping in `src/strava.ts`, re-derive the stored column
  with `scripts/moving-recategorize.sql` — the sync only rewrites rows it
  actually fetched, so older rows keep the old bucket otherwise.
- **Distances are stored in miles and feet**, converted on write, so nothing
  converts on the read path.
- **No polylines, coordinates, or streams are stored.** The page shows a date
  and a distance; what isn't stored can't leak.
- **`name` and `commute` are stored but not served.** The log renders a summary
  built from the numbers instead.
- **`stats` is recomputed from the archive**, not incremented — a run sees only a
  week, so the totals have to come from the whole table. `rides` counts both
  `ride` and `ebike`.
- **…but only when a row actually moved.** That recompute scans the table twice,
  and the cron fires every 30 minutes while re-offering the same week of overlap
  each time, so nearly every run has nothing to say. The write is an upsert
  guarded by a `WHERE` comparing every column, and `RETURNING` reports only the
  rows that were new or genuinely different — `changed` in the sync result. Zero
  means the totals cannot have moved, and the scan is skipped.
- **A daily floor covers out-of-band edits.** `changed` only sees rows this sync
  wrote, so anything that edits the table directly — `scripts/moving-recategorize.sql`
  after a change to the `kind` mapping is the standing example — would otherwise
  leave the totals wrong indefinitely, where before every sync quietly repaired
  them. `STATS_MAX_AGE` forces a rebuild once a day regardless, which bounds that
  to a day and still skips ~47 of the 48 runs.


## `/windows.json`

Bare activity time windows (`id`, `kind`, `startedAt`, `elapsedTime`) overlapping a range,
for the listening crossover. Overlap, not containment — an activity started before
`from` can still be running inside it. Cached an hour: past activities never change.
