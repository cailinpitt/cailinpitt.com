// Listening API for cailinpitt.com/listening.
//
// scheduled (every minute): pull Last.fm, append new scrobbles to D1, refresh
// now-playing; heavier aggregates recompute on slower cadences (see README).
// fetch: serve the precomputed bundle plus a /days endpoint for paginating
// older daily logs from D1.

import { fetchRecentTracks, type NowPlaying, type Scrobble } from './lastfm'
import { findMilestone, type PeriodStats } from './aggregate'
import { parsePeriod } from './periods'
import { blobKey, computePeriod, getPeriodIndex, pickWork, PREFIX, YEARS_TOUCHED_KEY } from './period'
import {
  countInWindows,
  fetchPeriodRows,
  playsBefore,
  priorLastPlay,
  returnsIn,
  summaryStatements,
} from './summary'
import {
  enrichIsIdle,
  enrichOneOrigin,
  enrichSome,
  metaWatermark,
  parkEnrichment,
  refreshLookups,
  wakeEnrichment,
} from './enrich'
import { renderText, renderYear } from './text'
import { computeOnThisDay, listYears, type OnThisDay } from './year'
import {
  computeHeatmap,
  computeStats,
  countScrobbles,
  dayRange,
  fetchDay,
  fetchLastPlayed,
  fetchOlderDays,
  groupDays,
  localDay,
  type Bundle,
  type DayLog,
} from './stats'
import { compactDays, type CompactDay } from './compact'

const HEAVY_INTERVAL = 15 * 60 // 7d/30d windows + recent logs
const HEATMAP_INTERVAL = 6 * 60 * 60 // year heatmap

// 2/min keeps up with new artists (~1.4k lookups/day); initial backfill uses scripts/enrich-listening.mjs
const ENRICH_EVERY_MINUTES = 2

const LOOKUP_INTERVAL = 24 * 60 * 60

const KEY = {
  now: 'now:v1',
  stats: 'stats:v1',
  heatmap: 'heatmap:v1',
  // Cold-path only, TTL'd — not the old per-tick meta:total counter. See totalFallback().
  totalFallback: 'meta:total:fallback',
  years: 'years:v1',
  lookupsBuiltAt: 'meta:v1:built-at',
  onThisDay: (date: string) => `onthisday:v1:${date}`,
} as const

const DAY = 86_400

// Archive data changes at most twice a day; a 1-min TTL here would waste Worker
// invocations and KV reads re-serving identical bytes.
const ARCHIVE_EDGE_TTL = 3600

/** KV minimum TTL is 60s. */
const TOTAL_FALLBACK_TTL = 300

const EDGE_TTL = 60

/** An activity is hours, not days. */
const DURING_MAX_SPAN = 24 * 60 * 60

// D1 caps ~50 statements per invocation; 30 windows (one statement each) matches
// a page of activities and leaves headroom.
const COUNTS_MAX_WINDOWS = 30

// Unauthenticated D1 endpoints are attacker-spendable budget, and edge caching
// doesn't help (vary a param, get a fresh key) — so the row cap is the lever.
// At 60 rows, exhausting the 5M row-read budget takes ~83k requests, past the
// 100k/day Workers ceiling, so Cloudflare cuts off requests before D1 does.
// 60 rows ~= 3.5h at a track every 3.5min; longer activities just truncate.
const DURING_MAX_ROWS = 60

// Callers pass an activity's start (already stable), so snapping is lossless for
// them while killing the cheapest cache-bust: nudging `from` by a second.
const DURING_SNAP = 60

const SITE_LISTENING = 'https://cailinpitt.com/listening'

interface NowBlob {
  nowPlaying: NowPlaying | null
  lastPlayed: Scrobble | null
  /** Straight from Last.fm's `@attr.total` — no COUNT(*) needed. */
  totalScrobbles: number
  // Tail of the Last.fm response, newest first. Free: ingest already fetches it
  // and writes this blob on every track change. getBundle() merges it over the
  // 15-min-old recentDays so the log reads current to ~1 min instead of 15.
  recent: Scrobble[]
  /** When this state last *changed*, not when the cron last ran — see ingest(). */
  updatedAt: number
}

/** Last.fm gives 50 per pull. */
const RECENT_CARRY = 40
interface StatsBlob {
  windows: Bundle['windows']
  recentDays: DayLog[]
  nextBefore: number | null
  computedAt: number
}
interface HeatmapBlob {
  heatmap: Bundle['heatmap']
  computedAt: number
}

const readJSON = <T>(env: Env, key: string): Promise<T | null> =>
  env.KV.get<T>(key, 'json')

// `updatedAt` is deliberately excluded — it ticks every run and would make every
// blob look "new".
const nowIdentity = (b: NowBlob) => JSON.stringify([b.nowPlaying, b.lastPlayed, b.totalScrobbles])

// Re-offer an hour of overlap on every pull: Last.fm can deliver a scrobble late
// or out of order, and INSERT OR IGNORE makes re-offering free.
const INGEST_GRACE = 3600

/** D1 caps 100 bound params per query; 6 columns → 16 rows per chunk. */
const INSERT_CHUNK = 16

const INSERT_COLS = 6

/** One multi-row INSERT per chunk, instead of one statement per scrobble. */
function insertStatements(env: Env, rows: Scrobble[]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = []
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK)
    const tuples = chunk
      .map((_, j) => {
        const b = j * INSERT_COLS
        return `(?${b + 1}, ?${b + 2}, ?${b + 3}, ?${b + 4}, ?${b + 5}, ?${b + 6})`
      })
      .join(', ')
    out.push(
      env.DB.prepare(
        // RETURNING yields only rows actually stored; the overlap dropped by OR
        // IGNORE must not reach the summary counters, which increment rather than recompute.
        `INSERT OR IGNORE INTO scrobbles (uts, track, artist, album, mbid, image)
         VALUES ${tuples}
         RETURNING uts, track, artist, album, mbid, image`,
      ).bind(...chunk.flatMap((s) => [s.uts, s.track, s.artist, s.album, s.mbid, s.image])),
    )
  }
  return out
}

async function ingest(env: Env): Promise<void> {
  const recent = await fetchRecentTracks({
    apiKey: env.LASTFM_API_KEY,
    user: env.LASTFM_USER,
    limit: 50,
  })

  // now:v1 tells us how far we already got, so we can skip re-offering rows we have.
  const prev = await readJSON<NowBlob>(env, KEY.now)

  // Free plan allows 50 D1 queries/invocation and batch() counts each statement
  // separately; one statement per scrobble hit ~49/tick with computeStats() and
  // computeHeatmap() still to run. Filtering to what's new and packing the rest
  // into multi-row INSERTs takes a normal tick to zero or one statement.
  const since = prev?.lastPlayed ? prev.lastPlayed.uts - INGEST_GRACE : 0
  const fresh = recent.scrobbles.filter((s) => s.uts > since)
  if (fresh.length) {
    const written = await env.DB.batch<Scrobble>(insertStatements(env, fresh))
    // Layer 1 moves only for rows that were genuinely new (see summaryStatements).
    const inserted = written.flatMap((r) => r.results ?? [])
    // Prior last_uts must be read before the upsert overwrites it — that gap is
    // what makes a "returning artist" detectable.
    const prior = await priorLastPlay(env.DB, inserted.map((r) => r.artist))
    const summary = summaryStatements(env, inserted, prior)
    if (summary.length) await env.DB.batch(summary)

    // A prior miss means a first-ever artist — wake the enrichment queue.
    if (inserted.some((r) => !prior.has(r.artist))) await wakeEnrichment(env)
  }

  // Last.fm returns newest-first, so scrobbles[0] is the most recent completed play.
  const next: NowBlob = {
    nowPlaying: recent.nowPlaying,
    lastPlayed: recent.scrobbles[0] ?? null,
    totalScrobbles: recent.total,
    recent: recent.scrobbles.slice(0, RECENT_CARRY),
    updatedAt: Math.floor(Date.now() / 1000),
  }

  // KV free tier allows 1,000 writes/day and this cron fires 1,440 times; only
  // write when something actually changed (a read is ~100x cheaper than a write).
  if (!prev || nowIdentity(prev) !== nowIdentity(next)) {
    await env.KV.put(KEY.now, JSON.stringify(next))
  }
}

async function refreshStats(env: Env): Promise<void> {
  const { windows, recentDays, nextBefore } = await computeStats(env.DB, env)
  const blob: StatsBlob = { windows, recentDays, nextBefore, computedAt: Math.floor(Date.now() / 1000) }
  await env.KV.put(KEY.stats, JSON.stringify(blob))
}

async function refreshHeatmap(env: Env): Promise<void> {
  const heatmap = await computeHeatmap(env.DB, env)
  const blob: HeatmapBlob = { heatmap, computedAt: Math.floor(Date.now() / 1000) }
  await env.KV.put(KEY.heatmap, JSON.stringify(blob))
}

// A live refresh is always one period; a backfill batch is several since the
// backfill is finite (~356 periods total), so its KV cost is fixed regardless of
// pace — BACKFILL_PER_TICK is sized against D1's per-invocation query ceiling.
async function runPeriodWork(env: Env, now: number): Promise<void> {
  const [index, bounds] = await Promise.all([getPeriodIndex(env, now), archiveBounds(env)])
  const unit = await pickWork(env, index, bounds.firstDay, now)
  if (!unit) return

  let touchedYear = false
  for (const period of unit.periods) {
    const stats = await computePeriod(env, period, now)
    await env.KV.put(blobKey(period.kind, period.key), JSON.stringify(stats))
    if (period.kind === 'y') touchedYear = true
    console.log(
      JSON.stringify({
        level: 'info',
        stage: 'period',
        key: `${period.kind}:${period.key}`,
        backfill: unit.backfill,
        scrobbles: stats.scrobbles,
      }),
    )
  }

  // Tell the all-time fold its inputs moved, once per tick regardless of how
  // many years the batch touched.
  if (touchedYear) await env.KV.put(YEARS_TOUCHED_KEY, String(now))
}

async function archiveBounds(env: Env): Promise<{ firstDay: string | null }> {
  const row = await env.DB.prepare('SELECT MIN(day) AS firstDay FROM days').first<{
    firstDay: string | null
  }>()
  return { firstDay: row?.firstDay ?? null }
}

// One cron tick: always ingest, then one unit of heavy work. Stats/heatmap
// refreshes and a period compute take turns rather than stacking; stats/heatmap
// go first since /listening and the homepage read them directly.
async function tick(env: Env): Promise<void> {
  // A Last.fm hiccup during ingest must not stop the D1-derived refreshes below.
  try {
    await ingest(env)
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', stage: 'ingest', error: String(err) }))
  }
  const now = Math.floor(Date.now() / 1000)

  const stats = await readJSON<StatsBlob>(env, KEY.stats)
  if (!stats || now - stats.computedAt >= HEAVY_INTERVAL) {
    await refreshStats(env)
    return
  }

  const heat = await readJSON<HeatmapBlob>(env, KEY.heatmap)
  if (!heat || now - heat.computedAt >= HEATMAP_INTERVAL) {
    await refreshHeatmap(env)
    return
  }

  // Enrichment runs before period work (genres/durations feed period blobs) and
  // only on some ticks.
  if (new Date(now * 1000).getUTCMinutes() % ENRICH_EVERY_MINUTES === 0) {
    try {
      if (await runEnrichment(env, now)) return
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', stage: 'enrich', error: String(err) }))
    }
  }

  await runPeriodWork(env, now)
}

// A couple of Last.fm lookups, then republish the lookup blobs on a slow
// cadence. The blobs are rebuilt daily rather than on every table change — a
// period computed before the rebuild just classifies slightly fewer artists,
// self-correcting on the next build.
async function runEnrichment(env: Env, now: number): Promise<boolean> {
  // Skip the anti-join queue scans while parked; the lookup check below still runs.
  const idle = await enrichIsIdle(env, now)

  let handled = 0
  let origins = false
  if (!idle) {
    const some = await enrichSome(env, now)
    handled = some.handled

    // One MusicBrainz artist per pass (caps at 1 req/s, resolveArtist may call twice).
    try {
      origins = await enrichOneOrigin(env, now)
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', stage: 'enrich-origin', error: String(err) }))
    }

    if (some.drained && !origins) await parkEnrichment(env, now)
  }

  // Rebuild when source data actually moved, not merely on a timer — see
  // metaWatermark(): a bulk SQL load can land rows without going through
  // enrichSome(), and a timer alone would leave lookups stale for up to a day.
  const stamp = await readJSON<{ at: number; watermark: number }>(env, KEY.lookupsBuiltAt)
  const watermark = await metaWatermark(env.DB)
  const stale = !stamp || now - stamp.at >= LOOKUP_INTERVAL || stamp.watermark !== watermark

  if (stale) {
    const counts = await refreshLookups(env)
    await env.KV.put(KEY.lookupsBuiltAt, JSON.stringify({ at: now, watermark }))
    console.log(JSON.stringify({ level: 'info', stage: 'lookups', watermark, ...counts }))
    return true
  }
  return handled > 0 || origins
}

/** Cheap (one KV read) — used by the homepage bar. */
async function getNow(env: Env): Promise<NowBlob> {
  const blob = await readJSON<NowBlob>(env, KEY.now)
  if (blob) return blob
  // now:v1 is owned by the cron; before its first run, fall back to D1's newest.
  // totalScrobbles stays 0 — only getBundle needs it and pays for the COUNT(*) itself.
  return {
    nowPlaying: null,
    lastPlayed: await fetchLastPlayed(env.DB),
    totalScrobbles: 0,
    recent: [],
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

// COUNT(*) scans the whole archive (~100k rows); without caching, a cold now:v1
// would make every concurrent request pay for a full scan until the next cron
// tick, and enough traffic could exhaust D1's daily row-read budget. The TTL
// bounds it to one scan per TTL, and the key expires once now:v1 is healthy again.
async function totalFallback(env: Env): Promise<number> {
  const cached = await env.KV.get(KEY.totalFallback)
  if (cached !== null) return Number(cached)
  const n = await countScrobbles(env.DB)
  await env.KV.put(KEY.totalFallback, String(n), { expirationTtl: TOTAL_FALLBACK_TTL })
  return n
}

const SPARK_DAYS = 90

// Projection of the heatmap blob the cron already computes (one KV read, no D1).
// Its own endpoint because /listening.json's full bundle is overkill for a
// 90-point line, and /now.json is deliberately uncached and kept to four fields.
// Today's bar inherits the heatmap's ~6h cadence, which is fine for a 90-day shape.
async function getSparkline(env: Env): Promise<{ from: string; days: number[] }> {
  const blob = await readJSON<HeatmapBlob>(env, KEY.heatmap)
  // No D1 fallback, deliberately: computeHeatmap scans a year of rows, and on a
  // cold blob that would mean a full-year scan per cache miss. The sparkline is
  // decoration, so it waits for the cron and the client hides an empty series.
  if (!blob) return { from: '', days: [] }
  const heatmap = blob.heatmap
  const offset = Number(env.TZ_OFFSET_SECONDS) || 0
  const now = Math.floor(Date.now() / 1000)

  // Walk calendar days rather than the blob's keys, so a zero-scrobble day still
  // gets its zero and keeps the spacing honest.
  const days: number[] = []
  let from = ''
  for (let i = SPARK_DAYS - 1; i >= 0; i--) {
    const key = localDay(now - i * 86_400, offset)
    if (!from) from = key
    days.push(heatmap.days[key] ?? 0)
  }
  return { from, days }
}

// /timeline's first page. Reads the same blobs and merge as getBundle, so the
// two pages can't disagree about a day; just drops the track lists /timeline
// never renders. No cold-KV rebuild — getBundle owns that path.
async function getTimelineDays(
  env: Env,
): Promise<{ days: CompactDay[]; nextBefore: number | null }> {
  const [nowInfo, stats] = await Promise.all([getNow(env), readJSON<StatsBlob>(env, KEY.stats)])
  if (!stats) return { days: [], nextBefore: null }
  const merged = mergeRecent(stats.recentDays, nowInfo.recent, Number(env.TZ_OFFSET_SECONDS) || 0)
  return { days: compactDays(merged), nextBefore: stats.nextBefore }
}

async function getBundle(env: Env): Promise<Bundle> {
  const now = Math.floor(Date.now() / 1000)
  const [nowInfo, statsBlob, heatBlob] = await Promise.all([
    getNow(env),
    readJSON<StatsBlob>(env, KEY.stats),
    readJSON<HeatmapBlob>(env, KEY.heatmap),
  ])

  // Cold KV (fresh deploy / evicted key): rebuild from D1 and cache it back. The
  // read path never calls Last.fm, so a Last.fm outage never fails a page load.
  let stats = statsBlob
  if (!stats) {
    const computed = await computeStats(env.DB, env)
    stats = { ...computed, computedAt: now }
    await env.KV.put(KEY.stats, JSON.stringify(stats))
  }

  let heat = heatBlob
  if (!heat) {
    heat = { heatmap: await computeHeatmap(env.DB, env), computedAt: now }
    await env.KV.put(KEY.heatmap, JSON.stringify(heat))
  }

  // The total rides along in now:v1 (Last.fm's own count) and only falls back to
  // D1 on a cold read before the first cron run; `||` short-circuits the fallback.
  const total = nowInfo.totalScrobbles || (await totalFallback(env))

  const yearKey = String(new Date((now + (Number(env.TZ_OFFSET_SECONDS) || 0)) * 1000).getUTCFullYear())
  const yearBlob = await readJSON<PeriodStats>(env, blobKey('y', yearKey))

  return {
    updatedAt: nowInfo.updatedAt,
    user: env.LASTFM_USER,
    totalScrobbles: total,
    nowPlaying: nowInfo.nowPlaying,
    lastPlayed: nowInfo.lastPlayed,
    windows: stats.windows,
    heatmap: heat.heatmap,
    // stats.recentDays is up to HEAVY_INTERVAL old; now:v1 is ~1 min old.
    recentDays: mergeRecent(stats.recentDays, nowInfo.recent, Number(env.TZ_OFFSET_SECONDS) || 0),
    // Unchanged: the cursor points at the *oldest* day, which merging never touches.
    nextBefore: stats.nextBefore,
    year: yearBlob
      ? {
          key: yearBlob.key,
          scrobbles: yearBlob.scrobbles,
          artists: yearBlob.artists,
          hours: yearBlob.listening?.seconds ? Math.round(yearBlob.listening.seconds / 3600) : 0,
          newArtists: yearBlob.discovery?.artists ?? 0,
          // Same coverage floor the period page and wrapped use.
          topGenre: yearBlob.genreCoverage >= 50 ? (yearBlob.genres?.[0]?.name ?? null) : null,
        }
      : null,
  }
}

// Splicing rather than re-fetching: groupDays() derives `count` from what it's
// given, and recentDays always holds every track for its days, so re-grouping
// can't double-count. Filtering on `uts` keeps it idempotent since the Last.fm
// tail overlaps what D1 already has.
function mergeRecent(days: DayLog[], recent: Scrobble[] | undefined, offset: number): DayLog[] {
  // `recent` is absent from blobs written before this field existed and stays
  // absent until the cron next rewrites now:v1 — do not assume it's there.
  const newest = days[0]?.tracks[0]?.uts ?? 0
  const fresher = (recent ?? []).filter((s) => s.uts > newest).sort((a, b) => b.uts - a.uts)
  if (!fresher.length) return days
  return groupDays([...fresher, ...days.flatMap((d) => d.tracks)], offset)
}

const tzOffset = (env: Env) => Number(env.TZ_OFFSET_SECONDS) || 0

/** MIN/MAX are cheap index seeks, but cached anyway. */
async function getYears(env: Env): Promise<number[]> {
  const cached = await readJSON<number[]>(env, KEY.years)
  if (cached) return cached
  const years = await listYears(env.DB, tzOffset(env))
  // A day: the list only changes at New Year or on a backfill.
  await env.KV.put(KEY.years, JSON.stringify(years), { expirationTtl: DAY })
  return years
}

function untilLocalMidnight(now: number, offset: number): number {
  const elapsed = (now + offset) % 86_400
  return Math.max(60, 86_400 - elapsed)
}

async function getOnThisDay(env: Env): Promise<OnThisDay> {
  const offset = tzOffset(env)
  const now = Math.floor(Date.now() / 1000)
  const date = new Date((now + offset) * 1000).toISOString().slice(5, 10)

  const cached = await readJSON<OnThisDay>(env, KEY.onThisDay(date))
  if (cached) return cached

  const result = await computeOnThisDay(env.DB, offset, now, await getYears(env))
  // Expires at local midnight, so tomorrow's date recomputes exactly once.
  await env.KV.put(KEY.onThisDay(date), JSON.stringify(result), {
    expirationTtl: untilLocalMidnight(now, offset),
  })
  return result
}

// Any loopback port so a dev server on 5174 still works without editing
// wrangler.jsonc. Everything served here is already public, so the allowlist is
// about not being a free CORS backend for other origins, not guarding secrets.
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN.split(',').map((o) => o.trim())
  const origin = request.headers.get('origin') ?? ''
  const ok = allowed.includes(origin) || LOOPBACK.test(origin)
  return {
    'access-control-allow-origin': ok ? origin : allowed[0],
    'access-control-allow-methods': 'GET, OPTIONS',
    vary: 'origin',
  }
}

// Deliberately narrow: anything not clearly a CLI fetcher gets normal JSON/HTML.
const CLI_AGENT = /^(curl|wget|httpie|HTTPie|xh|powershell|fetch)\b/i

function wantsText(request: Request, url: URL): boolean {
  if (url.searchParams.has('format') || url.searchParams.has('json')) return false
  const ua = request.headers.get('user-agent') ?? ''
  return CLI_AGENT.test(ua)
}

// Both builders omit CORS deliberately: it varies by Origin and is applied by
// withCors() after the cache, so a cached entry stays origin-independent.

function textResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': `public, max-age=${EDGE_TTL}`,
    },
  })
}

function json(body: unknown, maxAge: number): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
    },
  })
}

// Cloudflare doesn't cache Worker responses on its own, so without this every
// request pays its KV reads (3/bundle caps the free tier ~33k requests/day). It
// also collapses getBundle()'s cold-KV rebuild to once-per-colo per TTL.

// Not the raw request: the variant is folded into the URL since one path can
// produce two bodies (`/` is the terminal view for curl, a 404 for browsers).
// CORS is left off the cached body and re-applied per request instead of being
// duplicated per Origin.
const cacheKey = (url: URL, variant: string): Request => {
  const key = new URL(url.toString())
  key.searchParams.set('__variant', variant)
  return new Request(key.toString(), { method: 'GET' })
}

function withCors(res: Response, cors: Record<string, string>): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
  return out
}

/** Serve `build()` through the edge cache, adding this request's CORS on the way out. */
async function cached(
  url: URL,
  variant: string,
  ctx: ExecutionContext,
  cors: Record<string, string>,
  build: () => Promise<Response>,
): Promise<Response> {
  const key = cacheKey(url, variant)
  const hit = await caches.default.match(key)
  if (hit) return withCors(hit, cors)

  const fresh = await build()
  // Only success is worth storing; errors should retry immediately.
  if (fresh.status === 200) ctx.waitUntil(caches.default.put(key, fresh.clone()))
  return withCors(fresh, cors)
}

export default {
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(tick(env))
  },

  async fetch(request, env, ctx): Promise<Response> {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    const url = new URL(request.url)
    try {
      // `curl listening.cailinpitt.com` (or /listening) → the terminal view.
      if ((url.pathname === '/' || url.pathname === '/listening') && wantsText(request, url)) {
        return cached(url, 'text', ctx, cors, async () =>
          textResponse(
            renderText(await getBundle(env), {
              // ?T disables color, matching wttr.in's convention.
              color: !url.searchParams.has('T'),
              window:
                url.searchParams.get('w') === '30d' || url.searchParams.has('30d') ? '30d' : '7d',
              offset: Number(env.TZ_OFFSET_SECONDS) || 0,
            }),
          ),
        )
      }
      // A bare year — /2025 — is the year in review, in whichever form fits.
      const yearMatch = url.pathname.match(/^\/(\d{4})(\.json)?$/)
      if (yearMatch) {
        const year = Number(yearMatch[1])
        const asJson = Boolean(yearMatch[2])
        // Mirrors the /listening rule: curl gets text, a browser gets the page.
        if (!asJson && !wantsText(request, url)) {
          return new Response(null, {
            status: 302,
            headers: {
              location: `${SITE_LISTENING}/${year}`,
              'cache-control': 'no-store',
              ...cors,
            },
          })
        }
        // Straight off the period blob, same as /p/y/<year> — kept as an alias
        // since `curl listening.cailinpitt.com/2025` is a published address.
        return cached(url, `${asJson ? 'year-json' : 'year-text'}:${PREFIX}`, ctx, cors, async () => {
          const review = await readJSON<PeriodStats>(env, blobKey('y', String(year)))
          if (!review) {
            return new Response(`${year} is not built yet\n`, {
              status: 404,
              headers: { 'cache-control': 'public, max-age=60' },
            })
          }
          const ttl = review.complete ? ARCHIVE_EDGE_TTL * 24 : EDGE_TTL * 5
          return asJson
            ? json(review, ttl)
            : textResponse(renderYear(review, !url.searchParams.has('T')))
        })
      }
      // Period blobs are read-only by construction: a missing blob is a 404,
      // never a computation — the cron owns all of these.
      const periodMatch = url.pathname.match(/^\/p\/(w|m|y|all)\/([\w-]+)\.json$/)
      if (periodMatch) {
        const [, kind, key] = periodMatch
        const offset = Number(env.TZ_OFFSET_SECONDS) || 0
        // Validate before touching KV, so a junk key can't spend a read.
        const period = parsePeriod(kind, key, offset)
        if (!period) return new Response('Bad period', { status: 400, headers: cors })

        // PREFIX is part of the cache variant so bumping it invalidates the edge
        // too — otherwise a rebuild would be invisible for the full 24h TTL.
        return cached(url, `period:${PREFIX}`, ctx, cors, async () => {
          const blob = await readJSON<PeriodStats>(env, blobKey(period.kind, period.key))
          if (!blob) {
            // Not computed yet — short cache so the page picks it up once the
            // cron gets to it, rather than pinning a 404 at the edge for an hour.
            return new Response(JSON.stringify({ error: 'not ready' }), {
              status: 404,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'public, max-age=60',
              },
            })
          }
          // A finished period can never change again, so cache it hard.
          return json(blob, blob.complete ? ARCHIVE_EDGE_TTL * 24 : EDGE_TTL * 5)
        })
      }

      if (url.pathname === '/periods.json') {
        // Short TTL: this list grows every few minutes during backfill, and an
        // hour-long cache would pin an early, near-empty copy. Goes through the
        // same cached index as the cron (getPeriodIndex()), so a cold edge cache
        // can't force more than one real KV list() per INDEX_CACHE_INTERVAL.
        return cached(url, 'periods', ctx, cors, async () =>
          json(await getPeriodIndex(env, Math.floor(Date.now() / 1000)), EDGE_TTL),
        )
      }

      if (url.pathname === '/years.json') {
        return cached(url, 'years', ctx, cors, async () => json(await getYears(env), ARCHIVE_EDGE_TTL))
      }
      if (url.pathname === '/on-this-day.json') {
        return cached(url, 'otd', ctx, cors, async () => json(await getOnThisDay(env), ARCHIVE_EDGE_TTL))
      }

      // Same paths in a browser get redirected to the real page instead of a 404.
      // 302 + no-store deliberately: this response is UA-dependent, so a shared
      // cache could later replay the terminal view to a browser.
      if (url.pathname === '/' || url.pathname === '/listening') {
        return new Response(null, {
          status: 302,
          headers: { location: SITE_LISTENING, 'cache-control': 'no-store', ...cors },
        })
      }
      if (url.pathname === '/now.json') {
        // Deliberately uncached: one KV read, and the freshness here is actually
        // visible (the homepage now-playing bar). `recent` is projected out.
        const { nowPlaying, lastPlayed, totalScrobbles, updatedAt } = await getNow(env)
        return withCors(json({ nowPlaying, lastPlayed, totalScrobbles, updatedAt }, 30), cors)
      }
      if (url.pathname === '/sparkline.json') {
        return cached(url, 'spark', ctx, cors, async () =>
          json(await getSparkline(env), EDGE_TTL),
        )
      }
      if (url.pathname === '/listening.json') {
        return cached(url, 'json', ctx, cors, async () => json(await getBundle(env), EDGE_TTL))
      }
      // What was playing between two instants — /moving asks this per activity
      // when someone expands one. Cheap by construction (an idx_scrobbles_uts
      // range scan) rather than by caching; the span cap keeps it from becoming
      // a full-archive scan.
      if (url.pathname === '/during') {
        const from = Number(url.searchParams.get('from'))
        const to = Number(url.searchParams.get('to'))
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
          return new Response('Bad range', { status: 400, headers: cors })
        }
        if (to - from > DURING_MAX_SPAN) {
          return new Response('Range too wide', { status: 400, headers: cors })
        }
        // Snap before both the cache key and the query, so they agree.
        const snapFrom = Math.floor(from / DURING_SNAP) * DURING_SNAP
        const snapTo = Math.ceil(to / DURING_SNAP) * DURING_SNAP
        const key = new URL(url.toString())
        key.searchParams.set('from', String(snapFrom))
        key.searchParams.set('to', String(snapTo))
        return cached(key, 'during', ctx, cors, async () => {
          const rows = await fetchPeriodRows(env.DB, snapFrom, snapTo, DURING_MAX_ROWS)
          // A window already ended can never gain scrobbles, so it's cached hard;
          // one still in progress is not.
          const settled = snapTo < Math.floor(Date.now() / 1000) - 3600
          return json({ tracks: rows }, settled ? ARCHIVE_EDGE_TTL * 24 : EDGE_TTL)
        })
      }

      // Which of these windows have any music at all — asked once per /moving
      // render so the UI can hide the expander on activities with nothing to
      // show. Costs ~300 rows for a page of thirty and caches well since the
      // window list is stable until a new activity syncs.
      if (url.pathname === '/during-counts') {
        const spec = url.searchParams.get('w') ?? ''
        const windows: { from: number; to: number }[] = []
        for (const pair of spec.split(',').slice(0, COUNTS_MAX_WINDOWS)) {
          const [a, b] = pair.split('-').map(Number)
          if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue
          if (b - a > DURING_MAX_SPAN) continue
          // Snapped like /during, for the same reason.
          windows.push({
            from: Math.floor(a / DURING_SNAP) * DURING_SNAP,
            to: Math.ceil(b / DURING_SNAP) * DURING_SNAP,
          })
        }
        if (!windows.length) return new Response('No windows', { status: 400, headers: cors })

        return cached(url, 'during-counts', ctx, cors, async () =>
          json({ counts: await countInWindows(env.DB, windows) }, ARCHIVE_EDGE_TTL),
        )
      }

      // /timeline's first page: same days /listening.json carries, minus the
      // track lists it never renders.
      if (url.pathname === '/timeline.json') {
        return cached(url, 'timeline', ctx, cors, async () =>
          json(await getTimelineDays(env), EDGE_TTL),
        )
      }
      if (url.pathname === '/day.json') {
        const date = url.searchParams.get('date') ?? ''
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Bad date', { status: 400, headers: cors })
        return cached(url, 'day', ctx, cors, async () => {
          const offset = Number(env.TZ_OFFSET_SECONDS) || 0
          const day = await fetchDay(env.DB, offset, date)
          if (!day) return json(null, 300)

          const [start, end] = dayRange(date, offset)
          const [before, returning] = await Promise.all([
            playsBefore(env.DB, date),
            returnsIn(env.DB, start, end, 1),
          ])
          // fetchDay's tracks are newest-first; milestone numbering needs chronological order.
          const milestone = findMilestone([...day.tracks].reverse(), before)

          return json(
            { ...compactDays([day])[0], milestone, returning: returning[0] ?? null },
            300,
          )
        })
      }
      if (url.pathname === '/days') {
        // `compact=1` is part of the cache variant: one path, two bodies.
        const compact = url.searchParams.get('compact') === '1'
        return cached(url, compact ? 'days-compact' : 'days', ctx, cors, async () => {
          const offset = Number(env.TZ_OFFSET_SECONDS) || 0
          const before = Number(url.searchParams.get('before')) || Math.floor(Date.now() / 1000)
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5, 1), 14)
          const page = await fetchOlderDays(env.DB, offset, before, limit)
          return json(compact ? { ...page, days: compactDays(page.days) } : page, 300)
        })
      }
      return new Response('Not found', { status: 404, headers: cors })
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', route: url.pathname, error: String(err) }))
      return new Response('Internal error', { status: 500, headers: cors })
    }
  },
} satisfies ExportedHandler<Env>
