// Listening API for cailinpitt.com/listening.
//
//  scheduled (every minute): pull Last.fm, append new scrobbles to D1, refresh
//    now-playing. Heavier aggregates recompute on slower cadences so we never
//    scan the whole archive at 1/min — see the cost notes in the README.
//  fetch: serve the precomputed bundle (assembled from a few KV blobs) and a
//    /days endpoint for paginating older daily logs straight from D1.

import { fetchRecentTracks, type NowPlaying, type Scrobble } from './lastfm'
import { renderText } from './text'
import {
  computeHeatmap,
  computeStats,
  countScrobbles,
  fetchLastPlayed,
  fetchOlderDays,
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
} as const

/** How long the cold-path COUNT(*) result is reused for. KV minimum is 60s. */
const TOTAL_FALLBACK_TTL = 300

/** Edge-cache lifetime for the read endpoints. */
const EDGE_TTL = 60

// ---- shapes stored in KV -------------------------------------------------

interface NowBlob {
  nowPlaying: NowPlaying | null
  lastPlayed: Scrobble | null
  /** All-time count, straight from Last.fm's `@attr.total` — no COUNT(*) needed. */
  totalScrobbles: number
  /** When this state last *changed* (not when the cron last ran) — see ingest(). */
  updatedAt: number
}
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

/** Pull recent scrobbles, insert the new ones, refresh now-playing + total. */
async function ingest(env: Env): Promise<void> {
  const recent = await fetchRecentTracks({
    apiKey: env.LASTFM_API_KEY,
    user: env.LASTFM_USER,
    limit: 50,
  })

  if (recent.scrobbles.length) {
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO scrobbles (uts, track, artist, album, mbid, image)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    await env.DB.batch(
      recent.scrobbles.map((s) => stmt.bind(s.uts, s.track, s.artist, s.album, s.mbid, s.image)),
    )
  }

  // Last.fm returns newest-first, so scrobbles[0] is the most recent completed play.
  const next: NowBlob = {
    nowPlaying: recent.nowPlaying,
    lastPlayed: recent.scrobbles[0] ?? null,
    totalScrobbles: recent.total,
    updatedAt: Math.floor(Date.now() / 1000),
  }

  // KV's free tier allows 1,000 writes/day; this cron fires 1,440 times. Most runs
  // see the same track as the last one, so only write when something actually
  // changed — a KV read is ~100x cheaper than the write it saves.
  const prev = await readJSON<NowBlob>(env, KEY.now)
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
    recentDays: stats.recentDays,
    nextBefore: stats.nextBefore,
  }
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
// clearly a CLI fetcher gets the normal JSON/HTML behaviour.
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
      if (url.pathname === '/now.json') {
        // Deliberately uncached: one KV read, and this is the endpoint whose
        // freshness is actually visible (the homepage now-playing bar).
        return withCors(json(await getNow(env), 30), cors)
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
