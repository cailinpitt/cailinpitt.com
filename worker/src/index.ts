// Listening API for cailinpitt.com/listening.
//
//  scheduled (every minute): pull Last.fm, append new scrobbles to D1, refresh
//    now-playing. Heavier aggregates recompute on slower cadences so we never
//    scan the whole archive at 1/min — see the cost notes in the README.
//  fetch: serve the precomputed bundle (assembled from a few KV blobs) and a
//    /days endpoint for paginating older daily logs straight from D1.

import { fetchRecentTracks, type NowPlaying, type Scrobble } from './lastfm'
import { renderText, renderYear } from './text'
import {
  computeArtistDebuts,
  computeOnThisDay,
  computeYear,
  listYears,
  type OnThisDay,
  type YearReview,
} from './year'
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

const KEY = {
  now: 'now:v1',
  stats: 'stats:v1',
  heatmap: 'heatmap:v1',
  // Cold-path only, and TTL'd — NOT the old per-tick meta:total counter. See
  // totalFallback(). Written at most once per TTL, and only when now:v1 is absent.
  totalFallback: 'meta:total:fallback',
  years: 'years:v1',
  debuts: 'debuts:v1',
  year: (y: number) => `year:v1:${y}`,
  onThisDay: (date: string) => `onthisday:v1:${date}`,
} as const

const DAY = 86_400

/**
 * A finished year can never change, so its blob is written once and kept. Only
 * the year in progress is recomputed, twice a day — an annual summary has no
 * business moving faster than that, and each pass is ~60k D1 row reads.
 */
const YEAR_INTERVAL = 12 * 60 * 60

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
        `INSERT OR IGNORE INTO scrobbles (uts, track, artist, album, mbid, image)
         VALUES ${tuples}`,
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
  if (fresh.length) await env.DB.batch(insertStatements(env, fresh))

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

/** One cron tick: always ingest; recompute the rest only when stale. */
async function tick(env: Env): Promise<void> {
  // A Last.fm hiccup during ingest must not stop the D1-derived refreshes below.
  try {
    await ingest(env)
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', stage: 'ingest', error: String(err) }))
  }
  const now = Math.floor(Date.now() / 1000)

  const stats = await readJSON<StatsBlob>(env, KEY.stats)
  if (!stats || now - stats.computedAt >= HEAVY_INTERVAL) await refreshStats(env)

  const heat = await readJSON<HeatmapBlob>(env, KEY.heatmap)
  if (!heat || now - heat.computedAt >= HEATMAP_INTERVAL) await refreshHeatmap(env)
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
  const heatmap = blob?.heatmap ?? (await computeHeatmap(env.DB, env))
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

/**
 * Artist debut counts per year — one ~100k-row scan that serves every year, so it
 * is cached for a day rather than recomputed inside each year's build. Without
 * this, computing all six years would repeat the same scan six times.
 */
async function getDebuts(env: Env): Promise<Record<string, number>> {
  const cached = await readJSON<Record<string, number>>(env, KEY.debuts)
  if (cached) return cached
  const debuts = await computeArtistDebuts(env.DB, tzOffset(env))
  await env.KV.put(KEY.debuts, JSON.stringify(debuts), { expirationTtl: DAY })
  return debuts
}

interface YearBlob {
  review: YearReview
  computedAt: number
}

async function getYear(env: Env, year: number): Promise<YearReview | null> {
  const years = await getYears(env)
  if (!years.includes(year)) return null

  const now = Math.floor(Date.now() / 1000)
  const blob = await readJSON<YearBlob>(env, KEY.year(year))
  // `complete` years are immutable — never recompute one, whatever its age.
  if (blob && (blob.review.complete || now - blob.computedAt < YEAR_INTERVAL)) return blob.review

  const debuts = await getDebuts(env)
  const review = await computeYear(env.DB, tzOffset(env), year, now, debuts[String(year)] ?? 0)
  await env.KV.put(KEY.year(year), JSON.stringify({ review, computedAt: now } satisfies YearBlob))
  return review
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
        const review = await getYear(env, year)
        if (!review) {
          return new Response(`No scrobbles for ${year}\n`, { status: 404, headers: cors })
        }
        return cached(url, asJson ? 'year-json' : 'year-text', ctx, cors, async () =>
          asJson
            ? json(review, ARCHIVE_EDGE_TTL)
            : textResponse(renderYear(review, !url.searchParams.has('T'))),
        )
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
