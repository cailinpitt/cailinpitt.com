# Listening API (Cloudflare Worker)

Backs [`cailinpitt.com/listening`](https://cailinpitt.com/listening). Ingests
Last.fm scrobbles into a D1 archive on a cron and serves a precomputed JSON
bundle (from KV) to the static site.

- **`src/index.ts`** — `scheduled` (cron ingest + recompute) and `fetch` (read API).
- **`src/lastfm.ts`** — Last.fm `user.getRecentTracks` client.
- **`src/stats.ts`** — D1 → stat windows, heatmap, daily logs.
- **`schema.sql`** — the `scrobbles` table.

## How it stays on the free tier

The cron fires every minute, but only the cheap work runs that often:

| Cadence | Work | Cost |
|---|---|---|
| every 1 min | fetch Last.fm, `INSERT OR IGNORE` new scrobbles, refresh now-playing (KV) | no table scans |
| every 15 min | recompute 7d/30d windows + recent daily logs | reads only rows in-window (`uts` index) |
| every 6 h | recompute the year heatmap | ~one year of rows |
| — | all-time total | KV counter, seeded once — never `COUNT(*)` at runtime |

Well under D1's free limits (5 GB storage, 5M row-reads/day, 100k row-writes/day).
Reads are served from KV, so page loads never touch D1 or Last.fm.

## First-time setup

From this `worker/` directory (`npm install` first; needs `wrangler login`):

```bash
# 1. Create the datastores, then paste the printed ids into wrangler.jsonc
#    (database_id and the KV namespace id).
wrangler d1 create cailinpitt-listening
wrangler kv namespace create LISTENING

# 2. Apply the schema to the remote DB.
npm run schema:remote        # wrangler d1 execute … --remote --file=schema.sql

# 3. Store the Last.fm API key as a secret (value is in the project .env).
wrangler secret put LASTFM_API_KEY

# 4. Backfill your full history (run from the repo root). Writes a .sql file,
#    then load it into D1:
cd .. && node scripts/backfill-listening.mjs && cd worker
wrangler d1 execute cailinpitt-listening --remote --file=../scripts/backfill.sql

# 5. Deploy (cron + the listening.cailinpitt.com route come from wrangler.jsonc).
npm run deploy
```

Then point the site at the Worker by setting `VITE_LISTENING_API` at build time
(defaults to `https://listening.cailinpitt.com` if unset).

## Local development

```bash
echo 'LASTFM_API_KEY=…' > .dev.vars   # gitignored
wrangler dev --remote                 # --remote uses the real D1/KV
```

Read endpoints:

- `GET /listening.json` — the full bundle (now-playing, 7d/30d stats, heatmap, recent days).
- `GET /days?before=<uts>&limit=<n>` — older daily logs for pagination.

## Changing the timezone

Days are bucketed with a fixed offset (`TZ_OFFSET_SECONDS` in wrangler.jsonc):
`-18000` = US Central Daylight (UTC-5). Set to `-21600` for standard time. A fixed
offset can misplace a scrobble by an hour right at a DST switch — negligible here.
