// Listening API for cailinpitt.com/listening.
//
//  scheduled (every minute): pull Last.fm, append new scrobbles to D1, refresh
//    now-playing. Heavier aggregates recompute on slower cadences so we never
//    scan the whole archive at 1/min — see the cost notes in the README.
//  fetch: serve the precomputed bundle (assembled from a few KV blobs) and a
//    /days endpoint for paginating older daily logs straight from D1.

import { fetchRecentTracks, type NowPlaying, type Scrobble } from './lastfm'
import type { PeriodStats } from './aggregate'
import { parsePeriod } from './periods'
import { blobKey, computePeriod, listPeriods, pickWork, PREFIX, YEARS_TOUCHED_KEY } from './period'
import { countInWindows, fetchPeriodRows, priorLastPlay, summaryStatements } from './summary'
import { enrichOneOrigin, enrichSome, metaWatermark, refreshLookups } from './enrich'
import { renderText, renderYear } from './text'
import { computeOnThisDay, listYears, type OnThisDay } from './year'
import {
  computeHeatmap,
  computeStats,
  countScrobbles,
  fetchLastPlayed,
  fetchOlderDays,
  groupDays,
  localDay,
  type Bundle,
  type DayLog,
} from './stats'

const HEAVY_INTERVAL = 15 * 60 // 7d/30d windows + recent logs
const HEATMAP_INTERVAL = 6 * 60 * 60 // year heatmap

/**
 * Enrichment runs on every other minute, two entities at a time.
 *
 * That is ~1,440 lookups a day, so the initial 4,340 artists + 8,854 albums
 * would take about nine days from the cron alone — which is why there is a
 * backfill script (scripts/enrich-listening.mjs) to do it in one pass. This
 * cadence is for keeping up with new artists afterwards, a handful a day.
 */
const ENRICH_EVERY_MINUTES = 2

/** How often the artist→genre and track→duration lookup blobs are republished. */
const LOOKUP_INTERVAL = 24 * 60 * 60

const KEY = {
  now: 'now:v1',
  stats: 'stats:v1',
  heatmap: 'heatmap:v1',
  // Cold-path only, and TTL'd — NOT the old per-tick meta:total counter. See
  // totalFallback(). Written at most once per TTL, and only when now:v1 is absent.
  totalFallback: 'meta:total:fallback',
  years: 'years:v1',
  /** When the genre/duration lookup blobs were last rebuilt. */
  lookupsBuiltAt: 'meta:v1:built-at',
  onThisDay: (date: string) => `onthisday:v1:${date}`,
} as const

const DAY = 86_400

/**
 * Edge TTL for the archival endpoints. These are derived from data that changes
 * at most twice a day, so caching them for a minute (like the live bundle) would
 * spend Worker invocations and KV reads re-serving identical bytes.
 */
const ARCHIVE_EDGE_TTL = 3600

/** How long the cold-path COUNT(*) result is reused for. KV minimum is 60s. */
const TOTAL_FALLBACK_TTL = 300

/** Edge-cache lifetime for the read endpoints. */
const EDGE_TTL = 60

/** Widest span /during will answer. An activity is hours, not days. */
const DURING_MAX_SPAN = 24 * 60 * 60

/**
 * Most windows /during-counts will answer for at once. Each adds two bound
 * parameters against D1's ceiling of 100, so this is the real limit.
 */
const COUNTS_MAX_WINDOWS = 40

/**
 * Row cap for /during, chosen so the *request* ceiling binds before the D1 one.
 *
 * Every unauthenticated endpoint over D1 is a budget an attacker can spend, and
 * an edge cache does not help — vary a query param and the key is fresh. So the
 * lever is rows per request: at 60, exhausting 5M row-reads takes ~83k requests,
 * which is past the Workers free-plan ceiling of 100k/day. Cloudflare cuts off
 * requests before D1 dies, which is the failure mode you want.
 *
 * 60 covers ~3.5 hours at a track every 3.5 minutes. Longer activities truncate,
 * which is the right trade for a decorative list.
 */
const DURING_MAX_ROWS = 60

/**
 * Snap /during's bounds to a minute.
 *
 * Callers pass an activity's start, which is already stable, so this is lossless
 * for them. What it removes is the cheapest cache-bust: nudging `from` by a
 * second no longer mints a new cache entry and a new query.
 */
const DURING_SNAP = 60

/** Where a browser landing on the terminal endpoint gets sent. */
const SITE_LISTENING = 'https://cailinpitt.com/listening'

// ---- shapes stored in KV -------------------------------------------------

interface NowBlob {
  nowPlaying: NowPlaying | null
  lastPlayed: Scrobble | null
  /** All-time count, straight from Last.fm's `@attr.total` — no COUNT(*) needed. */
  totalScrobbles: number
  /**
   * The tail of the Last.fm response, newest first. Rides along for free: ingest
   * already fetches these and already writes this blob whenever the track
   * changes. getBundle() merges them over the 15-minute-old recentDays so the
   * log is current to ~1 min instead of lagging a quarter of an hour.
   */
  recent: Scrobble[]
  /** When this state last *changed* (not when the cron last ran) — see ingest(). */
  updatedAt: number
}

/** How many recent scrobbles to carry in now:v1 (Last.fm gives us 50 per pull). */
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

// ---- ingest + recompute --------------------------------------------------

// The parts of the blob a reader can actually observe. `updatedAt` is deliberately
// excluded: it ticks every run and would make every blob look "new".
const nowIdentity = (b: NowBlob) => JSON.stringify([b.nowPlaying, b.lastPlayed, b.totalScrobbles])

/**
 * Re-offer this much overlap on every pull. Last.fm can deliver a scrobble late
 * or slightly out of order, so filtering strictly on "newer than the last one we
 * saw" would drop it permanently. INSERT OR IGNORE makes the overlap free.
 */
const INGEST_GRACE = 3600

/** 100 bound parameters per query is a hard D1 limit; 6 columns → 16 rows. */
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
        // RETURNING yields only the rows that were actually stored. The hour of
        // overlap this pull re-offers is dropped by OR IGNORE and must not reach
        // the summary counters, which increment rather than recompute.
        `INSERT OR IGNORE INTO scrobbles (uts, track, artist, album, mbid, image)
         VALUES ${tuples}
         RETURNING uts, track, artist, album, mbid, image`,
      ).bind(...chunk.flatMap((s) => [s.uts, s.track, s.artist, s.album, s.mbid, s.image])),
    )
  }
  return out
}

/** Pull recent scrobbles, insert the new ones, refresh now-playing + total. */
async function ingest(env: Env): Promise<void> {
  const recent = await fetchRecentTracks({
    apiKey: env.LASTFM_API_KEY,
    user: env.LASTFM_USER,
    limit: 50,
  })

  // Read now:v1 up front: it tells us how far we already got, which is what lets
  // us skip re-offering 50 rows we already have.
  const prev = await readJSON<NowBlob>(env, KEY.now)

  // The Free plan allows 50 D1 queries per Worker invocation and a batch() counts
  // each statement separately. Sending one statement per scrobble meant ~49 per
  // tick — at the ceiling, with computeStats() and computeHeatmap() still to run
  // in the same invocation. Filtering to what is actually new and packing the
  // rest into multi-row INSERTs takes a normal tick to zero or one statement.
  const since = prev?.lastPlayed ? prev.lastPlayed.uts - INGEST_GRACE : 0
  const fresh = recent.scrobbles.filter((s) => s.uts > since)
  if (fresh.length) {
    const written = await env.DB.batch<Scrobble>(insertStatements(env, fresh))
    // Layer 1 moves only for rows that were genuinely new (see summaryStatements).
    const inserted = written.flatMap((r) => r.results ?? [])
    // Read the prior last_uts before the upsert overwrites it — that gap is the
    // only thing that makes a "returning artist" detectable.
    const prior = await priorLastPlay(env.DB, inserted.map((r) => r.artist))
    const summary = summaryStatements(env, inserted, prior)
    if (summary.length) await env.DB.batch(summary)
  }

  // Last.fm returns newest-first, so scrobbles[0] is the most recent completed play.
  const next: NowBlob = {
    nowPlaying: recent.nowPlaying,
    lastPlayed: recent.scrobbles[0] ?? null,
    totalScrobbles: recent.total,
    recent: recent.scrobbles.slice(0, RECENT_CARRY),
    updatedAt: Math.floor(Date.now() / 1000),
  }

  // KV's free tier allows 1,000 writes/day; this cron fires 1,440 times. Most runs
  // see the same track as the last one, so only write when something actually
  // changed — a KV read is ~100x cheaper than the write it saves.
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

/**
 * Compute at most one period blob.
 *
 * Strictly one per tick: a year is ~18,700 rows to read and fold, and stacking
 * several into one invocation is how both the CPU ceiling and the KV write
 * budget get blown. 1,440 ticks a day is a lot of room.
 */
async function runPeriodWork(env: Env, now: number): Promise<void> {
  const [index, bounds] = await Promise.all([listPeriods(env), archiveBounds(env)])
  const unit = await pickWork(env, index, bounds.firstDay, now)
  if (!unit) return

  const stats = await computePeriod(env, unit.period, now)
  await env.KV.put(blobKey(unit.period.kind, unit.period.key), JSON.stringify(stats))
  // Tell the all-time fold that its inputs moved. Year builds are rare — six on a
  // fresh archive, then the live year every six hours — so this is a handful of
  // KV writes a day.
  if (unit.period.kind === 'y') await env.KV.put(YEARS_TOUCHED_KEY, String(now))
  console.log(
    JSON.stringify({
      level: 'info',
      stage: 'period',
      key: `${unit.period.kind}:${unit.period.key}`,
      backfill: unit.backfill,
      scrobbles: stats.scrobbles,
    }),
  )
}

/** First and last day in the archive, straight off the `days` table's primary key. */
async function archiveBounds(env: Env): Promise<{ firstDay: string | null }> {
  const row = await env.DB.prepare('SELECT MIN(day) AS firstDay FROM days').first<{
    firstDay: string | null
  }>()
  return { firstDay: row?.firstDay ?? null }
}

/**
 * One cron tick: always ingest, then **one** unit of heavy work.
 *
 * The legacy stats/heatmap refreshes and a period compute are all expensive, so
 * they take turns rather than stacking. The legacy pair go first because
 * /listening and the homepage read them directly.
 */
/**
 * Enrichment: a couple of Last.fm lookups, then republish the lookup blobs on a
 * slow cadence.
 *
 * The blobs are two KV writes, so they are rebuilt daily rather than whenever
 * the underlying tables change — a period computed before the rebuild simply
 * classifies slightly fewer artists, which self-corrects on its next build.
 */
async function runEnrichment(env: Env, now: number): Promise<boolean> {
  const handled = await enrichSome(env, now)

  // One MusicBrainz artist per pass, at most. They cap at one request per second
  // and resolveArtist() can make two calls, so this is the slowest queue by far —
  // the bulk of the archive is done by scripts/musicbrainz-listening.mjs and this
  // only keeps up with newly-heard artists.
  let origins = false
  try {
    origins = await enrichOneOrigin(env, now)
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', stage: 'enrich-origin', error: String(err) }))
  }

  // Rebuild when the source data has actually moved, not merely when a timer
  // expired. See metaWatermark() — a bulk SQL load lands tens of thousands of
  // rows without passing through enrichSome(), and a timer alone would leave the
  // lookups pinned to a pre-load snapshot for up to a day.
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

  // Enrichment before period work, and only on some ticks. Genres and durations
  // feed the period blobs, so filling them first means fewer periods get built
  // against a half-empty lookup and then need rebuilding.
  if (new Date(now * 1000).getUTCMinutes() % ENRICH_EVERY_MINUTES === 0) {
    try {
      if (await runEnrichment(env, now)) return
    } catch (err) {
      console.log(JSON.stringify({ level: 'warn', stage: 'enrich', error: String(err) }))
    }
  }

  await runPeriodWork(env, now)
}

// ---- read API ------------------------------------------------------------

/** Now-playing / last-played only. Cheap (one KV read) — used by the homepage bar. */
async function getNow(env: Env): Promise<NowBlob> {
  const blob = await readJSON<NowBlob>(env, KEY.now)
  if (blob) return blob
  // now:v1 is owned by the cron; before its first run, fall back to D1's newest.
  // totalScrobbles stays 0 here — only getBundle needs it, and it pays for the
  // COUNT(*) itself rather than making every /now.json miss scan the archive.
  return {
    nowPlaying: null,
    lastPlayed: await fetchLastPlayed(env.DB),
    totalScrobbles: 0,
    recent: [],
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

/**
 * All-time count when now:v1 is missing. COUNT(*) reads the whole archive (~100k
 * rows), so without this a cold now:v1 would make *every* concurrent request pay
 * for a full scan until the next cron tick rewrote the key — enough traffic in
 * that window would exhaust D1's daily row-read budget outright. Caching the
 * result under a short TTL bounds it to one scan per TTL instead of one per
 * request, and the key expires on its own once now:v1 is healthy again.
 */
async function totalFallback(env: Env): Promise<number> {
  const cached = await env.KV.get(KEY.totalFallback)
  if (cached !== null) return Number(cached)
  const n = await countScrobbles(env.DB)
  await env.KV.put(KEY.totalFallback, String(n), { expirationTtl: TOTAL_FALLBACK_TTL })
  return n
}

/** How many days the homepage sparkline covers. */
const SPARK_DAYS = 90

/**
 * Daily counts for the last ~3 months, oldest first — the homepage sparkline.
 *
 * A projection of the heatmap blob the cron already computes, so this costs one
 * KV read and no D1 at all. It exists as its own endpoint because the homepage
 * would otherwise have to pull the whole /listening.json bundle (top lists,
 * windows, 40 tracks a day) to draw one 90-point line, and it can't ride on
 * /now.json, which is deliberately uncached and kept to four fields.
 *
 * Today's bar inherits the heatmap's ~6h cadence, so it can read low against a
 * day still in progress. That's the right trade here — a shape over 90 days
 * doesn't need minute freshness, and paying for a D1 scan to get it would.
 */
async function getSparkline(env: Env): Promise<{ from: string; days: number[] }> {
  const blob = await readJSON<HeatmapBlob>(env, KEY.heatmap)
  // No D1 fallback, deliberately — unlike getBundle, which rebuilds a cold blob.
  // computeHeatmap scans a year of rows, and this endpoint sits on the homepage:
  // on a cold or evicted key that would be a full-year scan on every 60s cache
  // miss until the next cron tick, up to six hours away. The sparkline is
  // decoration, so it does without until the cron fills the blob in, and the
  // client hides an empty series.
  if (!blob) return { from: '', days: [] }
  const heatmap = blob.heatmap
  const offset = Number(env.TZ_OFFSET_SECONDS) || 0
  const now = Math.floor(Date.now() / 1000)

  // Walk calendar days rather than the blob's keys: a day with no scrobbles has
  // no entry there, and the line needs its zero to keep the spacing honest.
  const days: number[] = []
  let from = ''
  for (let i = SPARK_DAYS - 1; i >= 0; i--) {
    const key = localDay(now - i * 86_400, offset)
    if (!from) from = key
    days.push(heatmap.days[key] ?? 0)
  }
  return { from, days }
}

async function getBundle(env: Env): Promise<Bundle> {
  const now = Math.floor(Date.now() / 1000)
  const [nowInfo, statsBlob, heatBlob] = await Promise.all([
    getNow(env),
    readJSON<StatsBlob>(env, KEY.stats),
    readJSON<HeatmapBlob>(env, KEY.heatmap),
  ])

  // Cold KV (fresh deploy / evicted key): rebuild the missing piece straight from
  // D1 and cache it back. The read path never calls Last.fm, so a Last.fm outage
  // can never make a page load fail — worst case now-playing is briefly stale.
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

  // The total rides along in now:v1 (Last.fm's own count). It's only missing on a
  // cold read before the first cron run, where D1 can stand in. `||` short-circuits,
  // so the fallback costs nothing on the normal path.
  const total = nowInfo.totalScrobbles || (await totalFallback(env))

  // One KV read on a bundle cache miss (not per request — this is edge-cached),
  // projected down to what the page actually shows.
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

/**
 * Splice scrobbles newer than the log's newest entry back into the day groups.
 *
 * Re-grouping the whole list is lossless — groupDays() derives `count` from the
 * tracks it is given, and recentDays always holds every track for its days — so
 * this cannot double-count a scrobble already present. Filtering on `uts` is what
 * keeps it idempotent: the Last.fm tail overlaps what D1 already has.
 */
function mergeRecent(days: DayLog[], recent: Scrobble[] | undefined, offset: number): DayLog[] {
  // `recent` is absent from blobs written before this field existed, and stays
  // absent until the cron next rewrites now:v1 — do not assume it is there.
  const newest = days[0]?.tracks[0]?.uts ?? 0
  const fresher = (recent ?? []).filter((s) => s.uts > newest).sort((a, b) => b.uts - a.uts)
  if (!fresher.length) return days
  return groupDays([...fresher, ...days.flatMap((d) => d.tracks)], offset)
}

// ---- year in review + on this day ---------------------------------------

const tzOffset = (env: Env) => Number(env.TZ_OFFSET_SECONDS) || 0

/** Which years have scrobbles. Cheap to derive (MIN/MAX are index seeks) but cached anyway. */
async function getYears(env: Env): Promise<number[]> {
  const cached = await readJSON<number[]>(env, KEY.years)
  if (cached) return cached
  const years = await listYears(env.DB, tzOffset(env))
  // A day: the list only changes at New Year, or the first time a backfill lands.
  await env.KV.put(KEY.years, JSON.stringify(years), { expirationTtl: DAY })
  return years
}

/** Seconds until the next local midnight — how long an "on this day" blob stays valid. */
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

// Any loopback port, so a dev server that lands on 5174 instead of 5173 still
// works without editing wrangler.jsonc. Everything this API serves is already
// public on the site, so the allowlist is about not being a free CORS backend
// for other origins — not about guarding secrets.
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

// Terminal client. Deliberately narrow: anything that is not
// clearly a CLI fetcher gets the normal JSON/HTML behavior.
const CLI_AGENT = /^(curl|wget|httpie|HTTPie|xh|powershell|fetch)\b/i

function wantsText(request: Request, url: URL): boolean {
  if (url.searchParams.has('format') || url.searchParams.has('json')) return false
  const ua = request.headers.get('user-agent') ?? ''
  return CLI_AGENT.test(ua)
}

// Both builders deliberately omit CORS: it varies by Origin and is applied by
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

// ---- edge cache ----------------------------------------------------------
//
// Cloudflare does not cache Worker-generated responses on its own, so without
// this every request executes the Worker and pays its KV reads — at 3 reads per
// bundle that caps the free tier around 33k requests/day. It also collapses the
// cold-KV rebuild paths in getBundle() from once-per-request to once-per-colo
// per TTL, which is what keeps a traffic spike off D1.

/**
 * Cache key. Deliberately *not* the raw request:
 *
 *  - The variant is folded into the URL because one path can produce two bodies
 *    (`/` is the terminal view for curl and a 404 for browsers).
 *  - CORS headers are left off the cached body entirely and re-applied per
 *    request, so the entry does not have to be duplicated per Origin.
 */
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
        // Straight off the period blob — no computation, same as /p/y/<year>.
        // These URLs stay because `curl listening.cailinpitt.com/2025` is a
        // published address, but they are now an alias, not a second code path.
        // Same blobs as /p/y/<year>, so the same namespace-aware variant.
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
      // ---- period blobs ---------------------------------------------------
      //
      // Read-only by construction: a missing blob is a 404, never a computation.
      // The cron owns every one of these, so no amount of traffic here can
      // trigger a D1 scan.
      const periodMatch = url.pathname.match(/^\/p\/(w|m|y|all)\/([\w-]+)\.json$/)
      if (periodMatch) {
        const [, kind, key] = periodMatch
        const offset = Number(env.TZ_OFFSET_SECONDS) || 0
        // Validate before touching KV, so a junk key can't spend a read.
        const period = parsePeriod(kind, key, offset)
        if (!period) return new Response('Bad period', { status: 400, headers: cors })

        // The blob namespace is part of the cache variant, so bumping PREFIX
        // invalidates the edge too. Without this, a completed period would keep
        // serving its previous body for the full 24-hour TTL after a rebuild —
        // the rebuild would be correct and invisible.
        return cached(url, `period:${PREFIX}`, ctx, cors, async () => {
          const blob = await readJSON<PeriodStats>(env, blobKey(period.kind, period.key))
          if (!blob) {
            // Not computed yet. Short cache so the page picks it up once the
            // cron gets to it, rather than pinning a 404 at the edge for an hour.
            return new Response(JSON.stringify({ error: 'not ready' }), {
              status: 404,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'public, max-age=60',
              },
            })
          }
          // A finished period can never change again, so let it be cached hard.
          return json(blob, blob.complete ? ARCHIVE_EDGE_TTL * 24 : EDGE_TTL * 5)
        })
      }

      if (url.pathname === '/periods.json') {
        // Short TTL, unlike the other archival endpoints: this list grows every
        // few minutes while the backfill walks history, and an hour-long cache
        // pins an early, near-empty copy for the whole of it.
        return cached(url, 'periods', ctx, cors, async () => json(await listPeriods(env), EDGE_TTL))
      }

      if (url.pathname === '/years.json') {
        return cached(url, 'years', ctx, cors, async () => json(await getYears(env), ARCHIVE_EDGE_TTL))
      }
      if (url.pathname === '/on-this-day.json') {
        return cached(url, 'otd', ctx, cors, async () => json(await getOnThisDay(env), ARCHIVE_EDGE_TTL))
      }

      // Same paths in a browser: send them to the real page instead of a 404.
      //
      // 302 and no-store, deliberately. This response is User-Agent dependent, so
      // a permanent or shared-cached redirect could later be replayed to a client
      // that wanted the terminal view — which would break `curl` for that URL.
      if (url.pathname === '/' || url.pathname === '/listening') {
        return new Response(null, {
          status: 302,
          headers: { location: SITE_LISTENING, 'cache-control': 'no-store', ...cors },
        })
      }
      if (url.pathname === '/now.json') {
        // Deliberately uncached: one KV read, and this is the endpoint whose
        // freshness is actually visible (the homepage now-playing bar).
        // `recent` is projected out — the bar needs four fields, not 40 tracks.
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
      // What was playing between two instants. Built for /moving, which asks it
      // per activity when someone expands one.
      //
      // Cheap by construction rather than by caching: an index range over
      // idx_scrobbles_uts returning a couple of dozen rows, and only when a
      // visitor actually asks. The span cap is what keeps it that way — without
      // it this is a full-archive scan with extra steps.
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
          // A window that has already ended can never gain scrobbles, so it is
          // immutable and cached hard; one still in progress is not.
          const settled = snapTo < Math.floor(Date.now() / 1000) - 3600
          return json({ tracks: rows }, settled ? ARCHIVE_EDGE_TTL * 24 : EDGE_TTL)
        })
      }

      // Which of these windows have any music at all.
      //
      // Asked once per /moving page render so the UI can hide the expander on
      // activities with nothing to show — thirty separate /during calls would be
      // absurd, and a toggle that opens to "nothing" is worse than no toggle.
      //
      // Costs one request and ~300 rows for a page of thirty, and the window
      // list is stable until a new activity syncs, so it caches well.
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

      if (url.pathname === '/days') {
        return cached(url, 'days', ctx, cors, async () => {
          const offset = Number(env.TZ_OFFSET_SECONDS) || 0
          const before = Number(url.searchParams.get('before')) || Math.floor(Date.now() / 1000)
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5, 1), 14)
          return json(await fetchOlderDays(env.DB, offset, before, limit), 300)
        })
      }
      return new Response('Not found', { status: 404, headers: cors })
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', route: url.pathname, error: String(err) }))
      return new Response('Internal error', { status: 500, headers: cors })
    }
  },
} satisfies ExportedHandler<Env>
