// Client for the listening API (the Cloudflare Worker in /worker). The page is
// prerendered as a static shell and fetches this data in the browser.

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
}

export type WindowKey = '7d' | '30d'

export interface YearReview {
  year: number
  scrobbles: number
  artists: number
  albums: number
  tracks: number
  activeDays: number
  perDay: number
  newArtists: number
  topArtists: ArtistStat[]
  topAlbums: AlbumStat[]
  topTracks: TrackStat[]
  /** Twelve counts, January first. */
  months: number[]
  busiestDay: { date: string; count: number } | null
  firstScrobble: Scrobble | null
  complete: boolean
}

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

export async function fetchYear(year: number, signal?: AbortSignal): Promise<YearReview> {
  const res = await fetch(`${API_BASE}/${year}.json`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<YearReview>
}

export async function fetchYears(signal?: AbortSignal): Promise<number[]> {
  const res = await fetch(`${API_BASE}/years.json`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<number[]>
}

export async function fetchOnThisDay(signal?: AbortSignal): Promise<OnThisDay> {
  const res = await fetch(`${API_BASE}/on-this-day.json`, { signal })
  if (!res.ok) throw new Error(`Listening API ${res.status}`)
  return res.json() as Promise<OnThisDay>
}

/** Lightweight now-playing payload for the homepage bar (see /now.json). */
export interface NowState {
  nowPlaying: NowPlaying | null
  lastPlayed: Scrobble | null
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
