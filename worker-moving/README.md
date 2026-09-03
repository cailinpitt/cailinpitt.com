# worker-moving

The API behind [cailinpitt.com/moving](https://cailinpitt.com/moving). Bike rides and lifting
sessions come from the Strava API; D1 stores them and a cron every 10 minutes pulls anything new.

Sibling of `worker-watching`, deliberately shaped like it — same CORS rules, same edge-cached
bundle, same `curl` text view, same admin-token `/sync`. No R2: activities carry no art.

## Nothing user-facing names Strava

The page, nav, terminal view, and row copy all avoid naming where this comes from — a deliberate
product decision, not an accident. Keep it in mind when editing `src/text.ts` or anything under
`src/` in the site. Comments and this file are implementation, and say Strava freely.

## Why the API, and what it costs

Strava restructured its developer program in June 2026: Standard Tier (≤10 athletes, this one)
now requires an active Strava subscription. There's no free path to an automated feed — the bulk
export is free but manual, and downstream services that used to relay Strava data are now barred
from serving it. `intervals.icu`, for instance, returns a stub for every Strava-sourced activity:

```json
{"id":"…","source":"STRAVA","_note":"STRAVA activities are not available via the API"}
```

Two limits worth knowing:

- **1,000 non-upload requests a day**, 100 per 15 minutes. A steady-state run spends one, so the
  30-minute cron spends about 48 a day — the access token is cached in `auth`, so most runs skip
  the refresh. A full `--refresh` over ~2,200 activities spends about 12.
- **The refresh token rotates on every exchange**, so it can't live in a Worker secret (write-only
  from the Worker's side) — the `auth` table in D1 holds the current one; the secret only seeds
  the first run.

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

`npm run moving:auth` (from the repo root) runs the one-time OAuth: it opens a local server on
port 8721 to catch the redirect, so set the Strava app's "Authorization Callback Domain" to
`localhost`. It asks for `activity:read_all` — without it, private activities are invisible to the
API and would silently miss from the archive.

Put the same `ADMIN_TOKEN` in the site's `.env` as `MOVING_ADMIN_TOKEN` — Cloudflare secrets are
write-only, and that file is the only place to read it back.

To start the database over (it holds nothing that isn't re-derivable):

```sh
npx wrangler d1 delete cailinpitt-moving
npx wrangler d1 create cailinpitt-moving   # paste the new id into wrangler.jsonc
npm run schema:remote
```

## Backfill

A cron run only looks at the last week. To import everything behind that, use the bulk export
rather than the API — it costs no requests and is already on disk:

```sh
# strava.com/settings/privacy → request an archive → unzip
node scripts/moving-backfill.mjs ~/Downloads/export_XXXXXXXX/activities.csv
npx wrangler d1 execute cailinpitt-moving --remote \
  --file=../scripts/moving-backfill.sql

# then correct the dates the CSV could only approximate — see below
cd .. && npm run moving:sync -- --refresh
```

That last step isn't optional. **The export carries no local timestamp**, only UTC, so
`moving-backfill.mjs` derives each calendar date with a fixed Central offset — wrong across DST
and anywhere but home. `--refresh` re-pulls every stored activity and takes Strava's own
per-activity local date, the only authority on which day a ride belongs to.

`npm run moving:sync -- --backfill` walks the history through the API instead, `PAGE_BUDGET` pages
per pass. A fallback for when the export isn't available; prefer the export.

## Endpoints

| Path | What |
| --- | --- |
| `GET /moving.json` | The bundle: first page of activities, plus totals |
| `GET /activities?cursor=&limit=&kind=` | Older activities, newest first |
| `GET /now.json` | The last activity, for the terminal and the /now bar |
| `GET /` with a CLI user-agent | The text view (`curl moving.cailinpitt.com`) |
| `POST /sync` | Runs the pull. Needs `Authorization: Bearer $ADMIN_TOKEN` |

`/sync` takes `?backfill=1` to walk backwards into the archive, `?refresh=1&page=N` to re-pull
history already stored, or `?recompute=1` to rebuild the totals from the archive with no Strava
call — for when the stats shape changed but the rows did not.

## Notes on the data

- **Ids are Strava's own activity ids** — what makes the export and API interchangeable: a row
  imported from the CSV and the same activity fetched later are the same row, so the two halves
  can't duplicate each other.
- **Rows are upserted** from the API and `INSERT OR IGNORE` from the backfill, so the live API
  always wins over the older snapshot. The upsert only writes when a column actually differs (see
  `changed`, below).
- **`kind` is derived from `sport_type`**, not stored by Strava: ride, ebike, lift, walk, run,
  yoga, climb, other. E-bikes are split from ordinary rides since they're different efforts and
  the page labels them differently. After changing that mapping in `src/strava.ts`, re-derive the
  stored column with `scripts/moving-recategorize.sql` — the sync only rewrites rows it actually
  fetched, so older rows keep the old bucket otherwise.
- **Distances are stored in miles and feet**, converted on write, so nothing converts on the read
  path.
- **No polylines, coordinates, or streams are stored.** The page shows a date and a distance; what
  isn't stored can't leak. Heart rate is the one exception to "numbers only", and it's two summary
  values — `avg_hr`, `max_hr` — never a per-second series.
- **Heart rate is null, not zero, when there was no monitor.** Most of the archive has none, and
  every row predating the column does. A stored zero would render "0 bpm" under a ride and drag
  any future average down, so the columns are nullable and `has_heartrate` is checked before
  either is read — Strava omits the values entirely on an activity without one, so this costs no
  extra API requests.
- **Both figures are labelled.** A row reads "145 avg · 178 max" behind a heart, since an
  unlabelled bpm number is ambiguous between the two. The page draws a `♥` glyph; the terminal
  view draws `<3`, since that output lands in whatever encoding the reader's terminal happens to
  use and a mojibaked glyph is worse than a plain one. `max` renders only when present — a
  separate field from the average, and a row can carry one without the other.
- **`name` and `commute` are stored but not served.** The log renders a summary built from the
  numbers instead.
- **`stats` is recomputed from the archive**, not incremented — a run sees only a week, so totals
  must come from the whole table. `rides` counts both `ride` and `ebike`. All-time bike miles, run
  miles, and run count are summed from `by_year` at read time, not stored as their own columns.
- **…but only when a row actually moved.** That recompute scans the table twice, and the cron
  fires every 10 minutes re-offering the same week of overlap each time, so nearly every run has
  nothing to say. The write is an upsert guarded by a `WHERE` comparing every column, and
  `RETURNING` reports only rows that were new or genuinely different — `changed` in the sync
  result. Zero means totals can't have moved, and the scan is skipped.
- **A daily floor covers out-of-band edits.** `changed` only sees rows this sync wrote, so
  anything editing the table directly — `scripts/moving-recategorize.sql` after a `kind` mapping
  change is the standing example — would otherwise leave totals wrong indefinitely, where before
  every sync quietly repaired them. `STATS_MAX_AGE` forces a rebuild once a day regardless,
  bounding that to a day while still skipping ~47 of the 48 runs.

## `/windows.json`

Bare activity time windows (`id`, `kind`, `startedAt`, `elapsedTime`) overlapping a range, for the
listening crossover. Overlap, not containment — an activity started before `from` can still be
running inside it. Cached an hour: past activities never change.
