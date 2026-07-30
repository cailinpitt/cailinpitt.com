// Listening API for cailinpitt.com/listening.
//
//  scheduled (every minute): pull Last.fm, append new scrobbles to D1, refresh
//    now-playing. Heavier aggregates recompute on slower cadences so we never
//    scan the whole archive at 1/min — see the cost notes in the README.
//  fetch: serve the precomputed bundle (assembled from a few KV blobs) and a
//    /days endpoint for paginating older daily logs straight from D1.

import { fetchRecentTracks, type NowPlaying, type Scrobble } from './lastfm'
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
} as const

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
  // cold read before the first cron run, where D1 can stand in.
  const total = nowInfo.totalScrobbles || (await countScrobbles(env.DB))

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

function json(body: unknown, cors: Record<string, string>, maxAge: number): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
      ...cors,
    },
  })
}

export default {
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(tick(env))
  },

  async fetch(request, env): Promise<Response> {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    const url = new URL(request.url)
    try {
      if (url.pathname === '/now.json') {
        // Small, fresh payload for the homepage now-playing bar.
        return json(await getNow(env), cors, 30)
      }
      if (url.pathname === '/listening.json') {
        return json(await getBundle(env), cors, 60)
      }
      if (url.pathname === '/days') {
        const offset = Number(env.TZ_OFFSET_SECONDS) || 0
        const before = Number(url.searchParams.get('before')) || Math.floor(Date.now() / 1000)
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5, 1), 14)
        return json(await fetchOlderDays(env.DB, offset, before, limit), cors, 300)
      }
      return new Response('Not found', { status: 404, headers: cors })
    } catch (err) {
      console.log(JSON.stringify({ level: 'error', route: url.pathname, error: String(err) }))
      return new Response('Internal error', { status: 500, headers: cors })
    }
  },
} satisfies ExportedHandler<Env>
