// Client for the listening API (the Cloudflare Worker in /worker). The page is
// prerendered as a static shell and fetches this data in the browser.

import { currentKey } from './periodKeys'

const API_BASE = import.meta.env.VITE_LISTENING_API ?? 'https://listening.cailinpitt.com'

export interface NowPlaying {
  track: string
  artist: string
  album: string | null
  image: string | null
}
export interface Scrobble extends NowPlaying {
  uts: number
}
export interface ArtistStat {
  name: string
  count: number
  image: string | null
}
export interface AlbumStat {
  album: string
  artist: string
  count: number
  image: string | null
}
export interface TrackStat {
  track: string
  artist: string
  count: number
  image: string | null
}
export interface StatWindow {
  scrobbles: number
  artists: number
  albums: number
  tracks: number
  perDay: number
  topArtists: ArtistStat[]
  topAlbums: AlbumStat[]
  topTracks: TrackStat[]
}
export interface DayLog {
  // YYYY-MM-DD. Bucketed by the Worker against a fixed US Central offset, so
  // this is Cailin's calendar day; times inside it render in the viewer's zone.
  date: string
  count: number
  tracks: Scrobble[]
}
export interface Heatmap {
  from: string
  to: string
  days: Record<string, number>
}
export interface Bundle {
  updatedAt: number
  user: string
  totalScrobbles: number
  nowPlaying: NowPlaying | null
  lastPlayed: Scrobble | null
  windows: Record<'7d' | '30d', StatWindow>
  heatmap: Heatmap
  recentDays: DayLog[]
  nextBefore: number | null
  /**
   * Five-field projection of the current year, carried by the bundle rather than
   * fetched separately — see the note on Bundle in the Worker's stats.ts.
   * Optional: a Worker deployed before this existed simply omits it.
   */
  year?: {
    key: string
    scrobbles: number
    artists: number
    hours: number
    newArtists: number
    topGenre: string | null
  } | null
}

export type WindowKey = '7d' | '30d'

export interface OnThisDayYear {
  year: number
  count: number
  topArtist: string | null
  tracks: Scrobble[]
}

export interface OnThisDay {
  date: string
  years: OnThisDayYear[]
}

export async function fetchOnThisDay(signal?: AbortSignal): Promise<OnThisDay> {
  const res = await fetch(`${API_BASE}/on-this-day.json`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<OnThisDay>
}

// ---- period stats (week / month / year / all time) ------------------------
//
// One blob per period, precomputed by the Worker's cron. The page never asks the
// API to aggregate anything — a period that hasn't been computed yet 404s and the
// UI says so, rather than triggering a scan of the archive.

export type PeriodKind = 'w' | 'm' | 'y' | 'all'

/**
 * The card every /listening sub-page shares.
 *
 * Period pages number in the hundreds — 284 weeks, 66 months, and growing by 52
 * a year — and generating a card apiece added ~6 minutes to every build to
 * produce images for URLs nobody shares. They point at the section's card
 * instead, which makes generate-og.mjs skip them entirely. Same trade the ~500
 * photo permalinks already make.
 *
 * The wrapped pages are the exception and keep their own cards: there are six,
 * and a year in review is the one page here anyone would share.
 */
export const LISTENING_OG_CARD = '/og/listening.jpg'

export interface RankedArtist {
  name: string
  count: number
  share: number
  image: string | null
  /** Rank on the *previous period's chart*, or null if it wasn't on it. */
  prevRank: number | null
  /** First ever heard in this period. Absent on blobs built before this existed. */
  isNew?: boolean
}
export interface RankedAlbum extends Omit<RankedArtist, 'name'> {
  album: string
  artist: string
}
export interface RankedTrack extends Omit<RankedArtist, 'name'> {
  track: string
  artist: string
}
export interface SeriesPoint {
  key: string
  label: string
  count: number
}
export interface Session {
  start: number
  end: number
  tracks: number
  topArtist: string | null
}
export interface Run {
  artist: string
  album?: string
  start: number
  tracks: number
  distinct: number
}
export interface Milestone {
  n: number
  uts: number
  track: string
  artist: string
}

export interface PeriodStats {
  kind: PeriodKind
  key: string
  label: string
  start: number
  end: number
  complete: boolean
  computedAt: number

  scrobbles: number
  artists: number
  albums: number
  tracks: number
  perDay: number
  activeDays: number
  silentDays: number

  top: { artists: RankedArtist[]; albums: RankedAlbum[]; tracks: RankedTrack[] }

  /** When the listening happened. */
  clock: number[] // 24, local hour
  weekdays: number[] // 7, Monday first
  grid: number[] // 168, weekday * 24 + hour
  peakHour: number | null
  quietestHour: number | null
  peakWeekday: number | null
  weekendShare: number
  lateNightShare: number

  series: SeriesPoint[]
  busiestDay: { date: string; count: number } | null
  busiestHour: { hour: number; count: number } | null

  streaks: { longest: number; longestSilence: number }
  sessions: { count: number; avgTracks: number; longest: Session | null }
  binges: Run[]
  albumListens: Run[]

  loyalty: {
    repeatRate: number
    top10Share: number
    effectiveArtists: number
    obsession: { track: string; artist: string; count: number; date: string } | null
  }

  curios: {
    remix: number
    live: number
    acoustic: number
    collab: number
    longestTitle: { track: string; artist: string } | null
  }

  /**
   * Genres (Tier B). Shares are of *classified* plays, not of all plays, so they
   * sum to 100 regardless of how much of the archive has been enriched;
   * `genreCoverage` is what says how much that is.
   */
  genres: { name: string; count: number; share: number }[]
  newGenres: string[]
  genreDiversity: number
  genreSeries: { key: string; label: string; genres: Record<string, number> }[]
  genreCoverage: number

  /**
   * Artist origin and era (Tier D). Country shares are of plays with a *known*
   * country, like genres; `coverage` says how many that is.
   */
  origins: {
    countries: { code: string; count: number; share: number }[]
    decades: { decade: number; count: number; share: number }[]
    groupShare: number
    soloShare: number
    coverage: number
  }

  /** Listening time (Tier C). `seconds` is extrapolated over unknown durations. */
  listening: {
    seconds: number
    coverage: number
    avgTrackSeconds: number
    topByTime: { name: string; seconds: number }[]
    longest: { track: string; artist: string; seconds: number } | null
  }

  /** What was playing during a logged activity (Tier F). */
  moving: {
    plays: number
    share: number
    activities: number
    byKind: { kind: string; count: number }[]
    topArtists: { name: string; count: number }[]
    topTracks: { track: string; artist: string; count: number }[]
  }

  milestones: Milestone[]
  first: Scrobble | null
  last: Scrobble | null

  discovery: {
    artists: number
    albums: number
    tracks: number
    rate: number
    newArtists: { name: string; uts: number }[]
    /** Artists back after a year or more away. */
    returning: { name: string; gapDays: number }[]
  }
  abandoned: string[]
  delta: {
    scrobbles: number | null
    artists: number | null
    tracks: number | null
    perDay: number | null
  }
}

/** Which period blobs exist, for the navigator. */
export interface PeriodIndex {
  w: string[]
  m: string[]
  y: string[]
  all: boolean
}

/** Thrown when a period is valid but the cron hasn't built it yet. */
export class PeriodNotReady extends Error {
  constructor() {
    super('period not ready')
    this.name = 'PeriodNotReady'
  }
}

/**
 * Completed periods are baked into the site build as static assets (see
 * scripts/bake-listening.mjs), which do not consume Worker requests at all.
 * Try the local copy first and fall back to the API, so a missing bake is a
 * slower path rather than a broken page.
 */
async function fetchPeriodBlob(kind: PeriodKind, key: string, signal?: AbortSignal) {
  // Only *completed* periods are ever baked, so trying the local path for the
  // current week/month/year is a guaranteed 404 before the real request — on the
  // period pages most likely to be visited. All-time is never complete either.
  const isLive = kind === 'all' || key === currentKey(kind)
  if (!isLive) {
    const local = await fetch(`/listening-data/${kind}/${key}.json`, { signal }).catch(() => null)
    // `ok` is not enough. A dev server — and any host with an SPA fallback —
    // answers an unknown path with index.html and a 200, which would sail
    // through here and then blow up in res.json(). Only a JSON content-type
    // means the bake actually produced this file.
    if (local?.ok && local.headers.get('content-type')?.includes('json')) return local
  }
  return fetch(`${API_BASE}/p/${kind}/${key}.json`, { signal })
}

export async function fetchPeriod(
  kind: PeriodKind,
  key: string,
  signal?: AbortSignal,
): Promise<PeriodStats> {
  const res = await fetchPeriodBlob(kind, key, signal)
  if (res.status === 404) throw new PeriodNotReady()
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<PeriodStats>
}

export async function fetchPeriodIndex(signal?: AbortSignal): Promise<PeriodIndex> {
  const res = await fetch(`${API_BASE}/periods.json`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<PeriodIndex>
}

/** Lightweight now-playing payload for the homepage bar (see /now.json). */
export interface NowState {
  nowPlaying: NowPlaying | null
  lastPlayed: Scrobble | null
  /**
   * All-time scrobbles, straight from Last.fm's own total — no COUNT(*) behind
   * it, which is why the cheapest endpoint can afford to carry it. Optional
   * because a Worker deployed before it was added simply omits the field, and a
   * missing counter should read as absent rather than as zero.
   */
  totalScrobbles?: number
  updatedAt: number
}

export async function fetchNow(signal?: AbortSignal): Promise<NowState> {
  const res = await fetch(`${API_BASE}/now.json`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<NowState>
}

/** 90 daily scrobble counts for the homepage sparkline (see /sparkline.json). */
export interface Sparkline {
  /** YYYY-MM-DD of the first (oldest) count. */
  from: string
  days: number[]
}

export async function fetchSparkline(signal?: AbortSignal): Promise<Sparkline> {
  const res = await fetch(`${API_BASE}/sparkline.json`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<Sparkline>
}

export async function fetchBundle(signal?: AbortSignal): Promise<Bundle> {
  const res = await fetch(`${API_BASE}/listening.json`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<Bundle>
}

/**
 * What was playing between two instants — the soundtrack to an activity.
 *
 * Fetched on demand rather than precomputed: nothing is spent unless a visitor
 * expands an activity, and the Worker answers from an index range of a couple of
 * dozen rows. A finished window is immutable, so it caches at the edge for a day.
 */
export async function fetchDuring(
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<Scrobble[]> {
  const res = await fetch(`${API_BASE}/during?from=${from}&to=${to}`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  const data = (await res.json()) as { tracks?: Scrobble[] }
  return data.tracks ?? []
}

/**
 * How many tracks fall inside each window, in one request.
 *
 * Used by /moving to decide which activities are worth offering an expander on.
 * Asking per activity would be thirty requests a page; this is one, and the
 * window list is stable enough to cache well. Returns [] on failure, so a
 * hiccup hides the expanders rather than breaking the page.
 */
export async function fetchDuringCounts(
  windows: { from: number; to: number }[],
  signal?: AbortSignal,
): Promise<number[]> {
  if (!windows.length) return []
  const spec = windows.map((w) => `${w.from}-${w.to}`).join(',')
  try {
    const res = await fetch(`${API_BASE}/during-counts?w=${spec}`, { signal })
    if (!res.ok) return []
    const data = (await res.json()) as { counts?: number[] }
    return data.counts ?? []
  } catch {
    return []
  }
}

export async function fetchOlderDays(
  before: number,
  limit = 5,
  signal?: AbortSignal,
): Promise<{ days: DayLog[]; nextBefore: number | null }> {
  const res = await fetch(`${API_BASE}/days?before=${before}&limit=${limit}`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<{ days: DayLog[]; nextBefore: number | null }>
}

// ---- music service search links ------------------------------------------
// Search links (not exact-track deep links) so every song resolves with no API
// keys or per-track lookups — the service opens a prefilled search.

export const spotifySearchUrl = (query: string) =>
  `https://open.spotify.com/search/${encodeURIComponent(query)}`

export const appleMusicSearchUrl = (query: string) =>
  `https://music.apple.com/search?term=${encodeURIComponent(query)}`

export const trackQuery = (artist: string, track: string) => `${artist} ${track}`
export const albumQuery = (artist: string, album: string) => `${artist} ${album}`

// ---- formatting ----------------------------------------------------------
//
// Shared with /reading, so it lives in datetime.ts. Re-exported here because
// this module is where the listening page has always imported it from.

export { formatDayLabel, formatNumber, formatRelative, formatTime } from './datetime'
