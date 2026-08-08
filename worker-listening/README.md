# Listening API (Cloudflare Worker)

Backs [`cailinpitt.com/listening`](https://cailinpitt.com/listening). Ingests Last.fm scrobbles
into D1 on a cron and serves a precomputed JSON bundle from KV.

| File | What it does |
|---|---|
| `src/index.ts` | `scheduled` (cron ingest + recompute) and `fetch` (read API) |
| `src/lastfm.ts` | Last.fm `user.getRecentTracks` client |
| `src/stats.ts` | D1 → stat windows, heatmap, daily logs |
| `src/text.ts` | the `curl listening.cailinpitt.com` view |
| `schema.sql` | the `scrobbles` table |

## Endpoints

- `GET /listening.json` — the full bundle (now-playing, 7d/30d stats, heatmap, recent days)
- `GET /days?before=<uts>&limit=<n>` — older daily logs, for pagination. `&compact=1` drops the
  track lists, keeping the date, count, and top artist
- `GET /timeline.json` — the bundle's recent days in that same compact shape, for /timeline
- `GET /now.json` — now-playing only; uncached
- `GET /p/<kind>/<key>.json` — one period's stats: `w/2026-W32`, `m/2026-08`, `y/2026`, `all/all`
- `GET /during-counts?w=<from>-<to>,…` — how many tracks fall in each window, batched
- `GET /during?from=<uts>&to=<uts>` — tracks played in a window; powers /moving's per-activity soundtrack
- `GET /periods.json` — which period blobs exist, for the navigator and the build-time bake
- `GET /` or `/listening` — terminal view for CLI user-agents, else a 302 to the site

`/<year>` and `/<year>.json` are aliases for `/p/y/<year>.json` — the published
`curl listening.cailinpitt.com/2025` address kept working, but it is no longer a
second implementation. The year-in-review that used to be computed from D1 on
request is gone.

### Period blobs are read-only

`/p/…` never computes anything. A period that the cron hasn't built yet returns
404 with a short cache, and the page says "not built yet" rather than triggering
a scan. This is the rule that keeps traffic off D1: a year is ~18,700 rows to
aggregate and the free plan allows 10 ms of CPU per fetch invocation, so no
amount of traffic to these endpoints can cost more than a KV read.

Completed periods are immutable and served with a 24-hour edge TTL; the site
additionally bakes them into the build as static assets, which don't count
against the Workers request ceiling at all.

### Unauthenticated endpoints are a budget anyone can spend

An edge cache does not protect a D1-backed endpoint from abuse: vary a query
parameter and the cache key is fresh. So the only real lever is **rows read per
request**, sized so the Workers request ceiling (100k/day) binds before D1's
row-read ceiling (5M/day) — Cloudflare then cuts off traffic instead of the
database going dark.

| Endpoint | Rows/request | Requests to exhaust 5M |
|---|---|---|
| `/during` | 60 | ~83k (past the 100k request cap) |
| `/during-counts` | ~300 (40 windows) | ~17k |
| `/days` | 900 | ~5.5k |
| `/p/…`, `/listening.json`, `/now.json` | 0 — KV only | n/a |

`/days` is the remaining soft spot, and it predates the period work. Its bound
used to be `maxDays * 250` = 3,500 rows for the 14 days `/timeline` asks for,
which is ~1,400 requests to a whole day's budget; it is now capped at 900.

**If this ever matters in practice, the fix is a Cloudflare Rate Limiting rule,
not more tuning here.** The free plan includes one, and rate limiting is the
right layer for it — no per-request cap makes an open endpoint immune.

**`/during` is cheap by construction, not by caching.** It is an index range over
`idx_scrobbles_uts` returning a couple of dozen rows, asked only when a visitor
expands an activity on /moving — a page of thirty costs nothing to render. The
24-hour span cap is what keeps it that way: without it the endpoint is a
full-archive scan with extra steps. A window that ended over an hour ago can
never gain scrobbles, so it caches for a day; one still in progress does not.

**The blob namespace is part of the edge cache key.** `PREFIX` is folded into the
cache variant for `/p/…` and `/<year>`, so bumping it invalidates the edge along
with KV. Without that, bumping the prefix would rebuild every period correctly
and change nothing a visitor could see for up to 24 hours — the rebuild would be
invisible behind a stale cache entry.

## Setup

From this directory (`npm install`, `wrangler login` first):

```bash
# 1. Create the datastores; paste the printed ids into wrangler.jsonc
wrangler d1 create cailinpitt-listening
wrangler kv namespace create LISTENING

# 2. Schema
npm run schema:remote

# 3. Secret (value is in the repo-root .env)
wrangler secret put LASTFM_API_KEY

# 4. Backfill history — writes a .sql file, then load it
cd .. && node scripts/backfill-listening.mjs && cd worker-listening
wrangler d1 execute cailinpitt-listening --remote --file=../scripts/backfill.sql

# 5. Deploy (cron + route come from wrangler.jsonc)
npm run deploy
```

Then set `VITE_LISTENING_API` at build time on the site (defaults to
`https://listening.cailinpitt.com`).

**Local development:**

```bash
echo 'LASTFM_API_KEY=…' > .dev.vars   # gitignored
wrangler dev --remote                 # --remote uses the real D1/KV
```

## Staying on the free tier

The cron fires every minute, but only the cheap work runs that often:

| Cadence | Work | Cost |
|---|---|---|
| 1 min | fetch Last.fm, `INSERT OR IGNORE`, refresh now-playing | no table scans; **KV write only when the track changed** |
| 1 min | maintain the Layer 1 summary tables | only for rows `RETURNING` proved were new |
| 15 min | recompute 7d/30d windows + recent daily logs | in-window rows only — **but only because of `INDEXED BY`**, see below |
| 6 h | recompute the year heatmap | ~one year of rows |
| 30 min / 2 h / 6 h / 24 h | recompute the live week / month / year / all-time blob | ~380 / 1,560 / 18,700 / 0 rows |
| 1 min | build completed period blobs to a cost budget, until none are missing | once per period, ever |
| — | all-time total | free with each Last.fm response (`@attr.total`); never `COUNT(*)` |

Reads are served from KV, so page loads never touch D1 or Last.fm.

**A tick does ingest plus at most one heavy thing.** Stacking the legacy refresh
and a period compute into one invocation is how the CPU ceiling and the KV write
budget both get blown, so they take turns. At 1,440 ticks a day there is no hurry.

**The backfill is finite, so its rate is not a budget question.** Building the
archive costs ~356 KV writes *total* — one per period, and then pickWork finds
nothing and it stops. Spreading those over eighteen hours costs exactly what
spreading them over two hours costs. An earlier version throttled it to one
period every three minutes, reasoning as though it ran forever; that bought
nothing and made a rebuild after a `PREFIX` bump take most of a day.

What actually binds is **CPU: 10 ms per invocation, scheduled events included.**
That is far tighter than the D1 query ceiling and is the real limit on how much a
tick can do. Batching several periods per tick blew through it, and the failure
mode is quiet — the invocation ends as `exceededCpu`, writes nothing, and the
backfill stalls on whatever period it reached with no error in the logs. It looks
exactly like the cron having stopped.

Two things kept it inside the budget:

- **One period per tick** (`TICK_BUDGET`). Raise it only with `wrangler tail`
  open, watching for an `exceededCpu` outcome.
- **The lookup blobs are parsed once per isolate, not once per period.** Genres,
  durations and origins total ~1 MB of JSON, and `KV.get(key, 'json')` parses on
  every call. The duration map is also joined against `tracks` so it holds only
  what has been played — 18k entries rather than the 50k `album.getInfo` returns.

The write budget still shapes everything *recurring*: KV allows 1,000/day,
`now:v1` spends ~300 and the live period blobs ~65. It is also why there is no
period *index* key — maintaining one would cost a write per frozen period, so
`/periods.json` lists KV instead, which costs a read.

**Layer 1 counters increment, so they must only see genuinely new rows.** Ingest
re-offers an hour of overlap on every pull and lets `INSERT OR IGNORE` drop the
duplicates. Those dropped rows must not reach the summary tables or `plays`
drifts upward every minute forever — hence `RETURNING` on the archive insert,
which yields only rows that were actually stored.

### Budget after the period work

Measured against the free tier: D1 5M rows read/day, KV 1,000 writes/day and 100k
reads/day, Workers 100k requests/day.

| | Per day | Of budget |
|---|---|---|
| D1 rows read — live week (48×380) + month (12×1,560) + year (4×18,700) | ~112k | 2% |
| D1 rows read — all-time fold, summary tables, discovery ranges | ~15k | <1% |
| D1 rows read — historical backfill, first day only (~2M once) | — | one-off |
| KV writes — `now:v1` | ~300 | 30% |
| KV writes — live periods (48+12+4+1) | 65 | 7% |
| KV writes — completed periods, throttled to every 3rd minute | ≤480 | 48% |
| KV writes — lookup blobs, on watermark change | ~3 | <1% |
| **KV writes total** | **~850 peak / ~370 steady** | under the 1,000 ceiling |

The backfill is the only thing that approaches the KV write ceiling, and only on
the day it runs — once the archive is walked, completed periods are never
rewritten and the steady state is ~370.

**Two things that were nearly cost regressions, and how they were avoided:**

*The year summary on `/listening`.* The obvious implementation fetches
`/p/y/<year>.json` from the page. That is a 21 KB response to display five
numbers, and — because a Cache API hit still executes the Worker — one extra
Worker invocation on **every** page view, against the 100k/day ceiling. It is
instead projected into the bundle the page already fetches, costing one KV read
per bundle cache miss rather than one request per view. Same reasoning as
`/now.json` dropping its 40-track tail.

*Returning-artist detection.* Asking "when did this artist last play before this
period" at read time walks every prior play of a heavy artist. Materializing the
return *events* instead (one `LAG()` pass, a few hundred rows) makes it an index
range, and ingest maintains it with 1–3 primary-key seeks — only on ticks that
actually inserted something.

**KV writes are the tight budget, not reads.** The free tier allows 100,000 reads but only **1,000
writes/day**, and the cron fires 1,440 times — so nothing on the per-minute path may write
unconditionally. `ingest()` reads `now:v1` and rewrites it only when the observable state
(now-playing, last-played, total) differs; `updatedAt` is excluded from the comparison or every run
would look changed. Budget: a few hundred writes/day for `now:v1`, 96 for `stats:v1`, 4 for
`heatmap:v1`.

### Four rules for changing anything here

Both expensive mistakes in this file were made by measuring *after* deploying.

**1. `GROUP BY artist` needs `INDEXED BY`.** It matches `idx_scrobbles_artist` exactly, so SQLite
plans `SCAN scrobbles USING INDEX idx_scrobbles_artist` — a full ~101k-row scan that **ignores the
`uts` range in the WHERE clause**. The query looks windowed and isn't. At the 15-minute cadence
that measured **22.5M rows/day against a 5M/day budget**, silently. Pin the range index:

```sql
FROM scrobbles INDEXED BY idx_scrobbles_uts WHERE uts >= ?1 GROUP BY artist
```

That gives `SEARCH scrobbles USING INDEX idx_scrobbles_uts (uts>?)` and 3,492 rows for the same
30-day result — 29× less. Album and track queries group on unindexed columns, so they already range
scan correctly. **Check `EXPLAIN QUERY PLAN` before deploying any new aggregate.** "SCAN … USING
INDEX" over a windowed query means the window isn't being used.

**2. 50 D1 queries per invocation is a real ceiling**, and `batch()` counts each statement
separately. Ingest once sent one `INSERT OR IGNORE` per scrobble — measured at 70,258 insert
statements in 24h to write 428 rows, ~49 per tick, with the refreshes tipping some ticks over.
Ingest now filters to scrobbles newer than the last one seen (with an hour of overlap, free because
`INSERT OR IGNORE`) and packs the rest into multi-row inserts. **100 bound parameters per query** is
a hard D1 limit, so 6 columns means 16 rows per statement. A normal tick is now zero or one.

**3. Aggregate in the Worker when the window is small.** 7d/30d used to be nine queries re-reading
the same rows. The 30-day window is ~1,600 rows and strictly contains both the 7-day window and the
log rows, so `computeStats()` fetches it once and folds all three out in JS — one query, ~1.6k rows
instead of ~10k. If you change `windowStats()`, re-verify against the SQL it replaced:
`COUNT(DISTINCT album)` counts album *names*, not name+artist, and it's easy to "fix" that into a
discrepancy.

**5. `UNION ALL` is capped at five branches.** D1 sets SQLITE_MAX_COMPOUND_SELECT
to 5, not SQLite's default 500, so a six-branch compound query fails at runtime
with `too many terms in compound SELECT` — and only at runtime, since nothing
about it is a type error. `countInWindows()` uses `db.batch()` of small
statements instead, which is bounded by the ~50-statements-per-invocation limit.
If you need N of something in one round trip, reach for `batch()`, not `UNION`.

**4. Two things that look cheap and aren't:** `SELECT COUNT(*)` over the archive reads ~100k rows
(at the 15-minute cadence that blows past 5M/day), and a per-tick counter key in KV costs a write
every time it moves.

### Freshness by piece

| Piece | Blob | Behind by |
|---|---|---|
| now-playing / last-played | `now:v1` | ~1 min |
| daily log (`recentDays`) | `stats:v1` + `now:v1` | ~1 min |
| 7d/30d windows | `stats:v1` | up to 15 min |
| heatmap | `heatmap:v1` | up to 6 h |

`recentDays` would naturally inherit `stats:v1`'s 15-minute cadence, which made the log lag the
now-playing bar by ~20 minutes. Instead `now:v1` carries the tail of the Last.fm response
(`recent`), and `mergeRecent()` splices anything newer than the log's newest entry in on read. This
is free — ingest already fetches those scrobbles and already writes that blob.

Re-grouping in `mergeRecent()` is safe because `groupDays()` derives `count` from the tracks it's
handed and `recentDays` always holds every track for its days; filtering on `uts` keeps it
idempotent. **Anything reading `now:v1` must treat `recent` as optional** — older blobs don't have
it, and the cron only rewrites on a real change.

### The edge cache

Cloudflare doesn't cache Worker-generated responses on its own, so every request used to execute
the Worker and pay 3 KV reads — capping the free tier at ~33k requests/day (100k ÷ 3), below the
100k Workers limit. `/listening.json`, `/days` and the terminal view now go through `caches.default`
with a 60s TTL.

Two things the cache key must account for:

- **The variant is folded into the key URL**, because one path produces two bodies — `/` is the
  terminal view for curl and a 302 for browsers.
- **CORS headers are never stored.** They vary by `Origin`, so the cached body is origin-independent
  and `withCors()` re-applies the right header per request. Storing them would serve one visitor's
  `access-control-allow-origin` to everyone behind that cache entry.

`/now.json` is deliberately uncached: one KV read, and the one endpoint whose staleness is visible.

## Terminal view

```bash
curl listening.cailinpitt.com          # 7-day window, color
curl listening.cailinpitt.com?T        # no color
curl listening.cailinpitt.com?w=30d    # 30-day window
```

The wttr.in trick: an 80-column ANSI page instead of JSON. Dispatch is on User-Agent (`curl`,
`wget`, `httpie`, `xh`, …) and only on `/` and `/listening` — `*.json` paths always return JSON, so
scripts piping into `jq` are unaffected. Color is on by default because curl can't tell the server
it's a TTY; `?T` opts out.

A browser on those paths gets a **302 with `no-store`** — deliberately not permanent or
shared-cacheable, since the response varies by User-Agent and a cached redirect could later be
replayed to a client that wanted the terminal view. Only the text variant is written to the edge
cache, keyed `__variant=text`.

Two rendering details that are easy to regress:

- Pad with `fit()` only for columns with something to their right. On a line's last field the
  padding lands *inside* the ANSI color wrap, where `trimEnd()` can't reach it.
- The 30-day sparkline takes `max(heatmap, recentDays)` per day. The heatmap recomputes every 6h, so
  on its own it draws today — the cell people look at first — as empty.

## Timezone

Days are bucketed with a fixed offset (`TZ_OFFSET_SECONDS` in wrangler.jsonc): `-18000` = US
Central Daylight (UTC-5), `-21600` for standard time. A fixed offset can misplace a scrobble by an
hour at a DST switch.
