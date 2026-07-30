// Client for the listening API (the Cloudflare Worker in /worker). The page is
// prerendered as a static shell and fetches this data in the browser.

const API_BASE = import.meta.env.VITE_LISTENING_API ?? 'https://listening.cailinpitt.com'

// Cailin's scrobbles are bucketed into days in US Central; format times/dates in
// the same zone so the log reads coherently regardless of the viewer's location.
const TZ = 'America/Chicago'

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
  date: string // YYYY-MM-DD (US Central)
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

const timeFmt = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: TZ,
})
const dayFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: TZ,
})
const numFmt = new Intl.NumberFormat('en-US')

export const formatNumber = (n: number) => numFmt.format(n)
export const formatTime = (uts: number) => timeFmt.format(uts * 1000)

/** "Today" / "Yesterday" / "Monday, June 9" from a YYYY-MM-DD (US Central) key. */
export function formatDayLabel(date: string): string {
  const todayKey = keyForOffset(0)
  const yesterdayKey = keyForOffset(-1)
  if (date === todayKey) return 'Today'
  if (date === yesterdayKey) return 'Yesterday'
  // Parse the date-only key as noon UTC to avoid it slipping across a boundary.
  return dayFmt.format(new Date(`${date}T12:00:00Z`))
}

function keyForOffset(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000)
  // en-CA gives an ISO-ish YYYY-MM-DD, in the target zone.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)
}

/** Compact "just now / 5m ago / 3h ago / 2d ago" from unix seconds. */
export function formatRelative(uts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - uts)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
}
