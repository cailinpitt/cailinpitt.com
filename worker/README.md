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
| every 1 min | fetch Last.fm, `INSERT OR IGNORE` new scrobbles, refresh now-playing (KV) | no table scans; **KV write only when the track actually changed** |
| every 15 min | recompute 7d/30d windows + recent daily logs | reads only rows in-window — but **only because of `INDEXED BY`**, see below |
| every 6 h | recompute the year heatmap | ~one year of rows |
| — | all-time total | comes free with each Last.fm response (`@attr.total`) — never `COUNT(*)` at runtime |

Well under D1's free limits (5 GB storage, 5M row-reads/day, 100k row-writes/day).
Reads are served from KV, so page loads never touch D1 or Last.fm.

**KV writes are the tight budget, not reads.** The free tier allows 100,000 reads
but only **1,000 writes per day**, and the cron fires 1,440 times — so nothing on
the per-minute path may write unconditionally. `ingest()` therefore reads `now:v1`
and re-writes it only when the observable state (now-playing, last-played, total)
differs; `updatedAt` is excluded from that comparison since it would otherwise make
every run look changed. Budget: a few hundred writes/day for `now:v1`, 96 for
`stats:v1`, 4 for `heatmap:v1`.

### How fresh each piece is

Different parts of the bundle come from blobs on different cadences, which is the
main thing to understand before changing any of it:

| Piece | Blob | Behind by |
|---|---|---|
| now-playing / last-played | `now:v1` | ~1 min (cron) |
| daily log (`recentDays`) | `stats:v1` + `now:v1` | ~1 min — see below |
| 7d/30d windows | `stats:v1` | up to 15 min |
| heatmap | `heatmap:v1` | up to 6 h |

`recentDays` would naturally inherit `stats:v1`'s 15-minute cadence, which made
the log visibly lag the now-playing bar by ~20 minutes. Instead `now:v1` carries
the tail of the Last.fm response (`recent`), and `mergeRecent()` splices anything
newer than the log's newest entry back in on read. This is free: ingest already
fetches those scrobbles and already writes that blob when the track changes.

Re-grouping in `mergeRecent()` is safe because `groupDays()` derives `count` from
the tracks it is handed and `recentDays` always holds every track for its days;
filtering on `uts` keeps it idempotent, since the Last.fm tail overlaps D1.

Anything reading `now:v1` must treat `recent` as optional — blobs written before
the field existed do not have it, and the cron only rewrites on a real change.

### The edge cache

Cloudflare does **not** cache Worker-generated responses on its own, so before
the Cache API was added every request executed the Worker and paid its 3 KV
reads — which capped the free tier at roughly 33k requests/day (100k reads ÷ 3),
well below the 100k Workers request limit. `/listening.json`, `/days` and the
terminal view now go through `caches.default` with a 60s TTL, so repeat traffic
costs no KV reads at all.

Two things the cache key has to account for, both easy to get wrong:

- **The variant is folded into the key URL**, because one path can produce two
  different bodies — `/` is the terminal view for curl and a 404 for browsers.
- **CORS headers are never stored.** They vary by `Origin`, so the cached body is
  origin-independent and `withCors()` re-applies the right header per request.
  Storing them would serve one visitor's `access-control-allow-origin` to
  everyone behind the same cache entry.

`/now.json` is deliberately left uncached: it is a single KV read, and it is the
one endpoint whose staleness is visible (the homepage now-playing bar).

### Queries per invocation is a real ceiling

The Free plan allows **50 D1 queries per Worker invocation**, and `batch()` counts
each statement in it separately. Ingest used to send one `INSERT OR IGNORE` per
scrobble — up to 50 — and then `computeStats()` and `computeHeatmap()` ran in the
same invocation. Measured at **70,258 insert statements in 24h to write 428
rows**: ~49 per tick, right at the ceiling, with the refreshes tipping some ticks
over it. The symptom was a refresh count of 141/day where 192 was expected.

Ingest now filters to scrobbles newer than the last one it saw (with an hour of
overlap, since Last.fm can deliver late and `INSERT OR IGNORE` makes the overlap
free) and packs the rest into multi-row `INSERT`s. **100 bound parameters per
query** is a hard D1 limit, so with 6 columns that is 16 rows per statement. A
normal tick is now zero or one statement.

### Aggregate in the Worker when the window is small

7d/30d used to be four SQL aggregates per window — eight queries re-reading the
same rows, plus a ninth for the log. The 30-day window is only ~1,600 rows and
strictly contains both the 7-day window and the 11 days of log rows, so
`computeStats()` fetches it **once** and folds all three out of it in JS. Nine
queries became one, and ~10k rows read became ~1.6k.

Verified equal to the SQL it replaced against a fixed window: scrobbles, artists,
albums, tracks and the top-5 artists all matched exactly. If you change
`windowStats()`, re-run that comparison — `COUNT(DISTINCT album)` counts album
*names*, not name+artist, and it is easy to "fix" that into a discrepancy.

### `GROUP BY artist` needs `INDEXED BY` — this one bites

`GROUP BY artist` matches `idx_scrobbles_artist` exactly, so SQLite prefers that
index and plans `SCAN scrobbles USING INDEX idx_scrobbles_artist` — a full
~101k-row scan that **ignores the `uts` range in the WHERE clause entirely**. The
query looks windowed and is not.

At the 15-minute refresh cadence that measured **22.5M rows/day against a 5M/day
free-tier budget**, silently, for as long as the worker had been deployed.
Pinning the range index:

```sql
FROM scrobbles INDEXED BY idx_scrobbles_uts WHERE uts >= ?1 GROUP BY artist
```

gives `SEARCH scrobbles USING INDEX idx_scrobbles_uts (uts>?)` and 3,492 rows for
the same 30-day result — 29× less. The album and track queries group on columns
with no matching index, so they already range-scan correctly and need no hint.

**Check `EXPLAIN QUERY PLAN` before deploying any new aggregate here.** "SCAN …
USING INDEX" over a windowed query means the window is not being used. Measuring
after deploying is how both of the expensive mistakes in this file got made.

Two things that look cheap but are not, if you are tempted to add them back:
`SELECT COUNT(*)` over the archive reads ~100k D1 rows, so at the 15-minute cadence
it would blow past D1's 5M row-reads/day; and a per-tick counter key in KV costs a
write every time it moves.

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
- `GET /` or `/listening` — the terminal view, when the User-Agent is a CLI fetcher.

## The terminal view (`src/text.ts`)

The wttr.in trick: `curl listening.cailinpitt.com` renders the same data as an
80-column ANSI page instead of JSON.

```bash
curl listening.cailinpitt.com          # 7-day window, color
curl listening.cailinpitt.com?T        # no color
curl listening.cailinpitt.com?w=30d    # 30-day window
```

Dispatch is on User-Agent (`curl`, `wget`, `httpie`, `xh`, …) and only on `/` and
`/listening` — `*.json` paths always return JSON, whoever asks, so scripts piping
`curl … /listening.json` into `jq` are unaffected. Color is on by default because
curl cannot tell the server it is a TTY; `?T` opts out, following wttr.in.

A browser on those same paths gets a 302 to `cailinpitt.com/listening` rather
than a 404. It is a 302 with `no-store` on purpose: the response varies by
User-Agent, so a permanent or shared-cached redirect could later be replayed to a
client that wanted the terminal view and would break `curl` for that URL. Only
the text variant is ever written to the edge cache, keyed with `__variant=text`,
so the two can never be served to the wrong client.

Two rendering details that are easy to regress:

- Pad with `fit()` only for columns that have something to their right. On a
  line's last field the padding lands *inside* the ANSI color wrap, where no
  later `trimEnd()` can reach it.
- The 30-day sparkline takes `max(heatmap, recentDays)` per day. The heatmap only
  recomputes every 6 h, so on its own it draws today — the cell people look at
  first — as an empty day.

## Changing the timezone

Days are bucketed with a fixed offset (`TZ_OFFSET_SECONDS` in wrangler.jsonc):
`-18000` = US Central Daylight (UTC-5). Set to `-21600` for standard time. A fixed
offset can misplace a scrobble by an hour right at a DST switch — negligible here.
