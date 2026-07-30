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
  total: 'meta:total',
} as const

// ---- shapes stored in KV -------------------------------------------------

interface NowBlob {
  nowPlaying: NowPlaying | null
  lastPlayed: Scrobble | null
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

/** Pull recent scrobbles, insert the new ones, refresh now-playing + total. */
async function ingest(env: Env): Promise<void> {
  const recent = await fetchRecentTracks({
    apiKey: env.LASTFM_API_KEY,
    user: env.LASTFM_USER,
    limit: 50,
  })

  let added = 0
  if (recent.scrobbles.length) {
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO scrobbles (uts, track, artist, album, mbid, image)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    const results = await env.DB.batch(
      recent.scrobbles.map((s) => stmt.bind(s.uts, s.track, s.artist, s.album, s.mbid, s.image)),
    )
    added = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0)
  }

  // Last.fm returns newest-first, so scrobbles[0] is the most recent completed play.
  const nowBlob: NowBlob = {
    nowPlaying: recent.nowPlaying,
    lastPlayed: recent.scrobbles[0] ?? null,
    updatedAt: Math.floor(Date.now() / 1000),
  }
  await env.KV.put(KEY.now, JSON.stringify(nowBlob))
  await bumpTotal(env, added)
}

/** Keep the all-time count as a KV counter so we never COUNT(*) at 1/min. */
async function bumpTotal(env: Env, added: number): Promise<void> {
  const current = await env.KV.get(KEY.total)
  if (current === null) {
    // One-time seed from the archive (new scrobbles already inserted above).
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM scrobbles').first<{ n: number }>()
    await env.KV.put(KEY.total, String(row?.n ?? 0))
  } else if (added > 0) {
    await env.KV.put(KEY.total, String(Number(current) + added))
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

async function getBundle(env: Env): Promise<Bundle> {
  const now = Math.floor(Date.now() / 1000)
  const [nowBlob, statsBlob, heatBlob, totalStr] = await Promise.all([
    readJSON<NowBlob>(env, KEY.now),
    readJSON<StatsBlob>(env, KEY.stats),
    readJSON<HeatmapBlob>(env, KEY.heatmap),
    env.KV.get(KEY.total),
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

  let total = totalStr
  if (total === null) {
    total = String(await countScrobbles(env.DB))
    await env.KV.put(KEY.total, total)
  }

  // now:v1 is owned by the cron. If it isn't there yet, fall back to the newest
  // row in D1 for "last played" (now-playing stays null until the cron runs).
  const nowInfo = nowBlob ?? {
    nowPlaying: null,
    lastPlayed: await fetchLastPlayed(env.DB),
    updatedAt: now,
  }

  return {
    updatedAt: nowInfo.updatedAt,
    user: env.LASTFM_USER,
    totalScrobbles: Number(total),
    nowPlaying: nowInfo.nowPlaying,
    lastPlayed: nowInfo.lastPlayed,
    windows: stats.windows,
    heatmap: heat.heatmap,
    recentDays: stats.recentDays,
    nextBefore: stats.nextBefore,
  }
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN.split(',').map((o) => o.trim())
  const origin = request.headers.get('origin') ?? ''
  return {
    'access-control-allow-origin': allowed.includes(origin) ? origin : allowed[0],
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
