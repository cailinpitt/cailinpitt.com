// Thin Last.fm client — just the `user.getRecentTracks` call the ingest and the
// backfill both need. Returns normalized rows plus the current "now playing"
// track (the one row Last.fm sends without a timestamp).

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/'

export interface Scrobble {
  uts: number
  track: string
  artist: string
  album: string | null
  mbid: string | null
  image: string | null
}

export type NowPlaying = Omit<Scrobble, 'uts'>

export interface RecentResult {
  nowPlaying: NowPlaying | null
  scrobbles: Scrobble[]
  total: number
  totalPages: number
}

interface RawImage {
  size: string
  '#text': string
}

interface RawTrack {
  name: string
  mbid?: string
  album?: { '#text'?: string }
  // With extended=1 the artist is an object with `name`; otherwise `#text`.
  artist?: { name?: string; '#text'?: string }
  image?: RawImage[]
  date?: { uts: string }
  '@attr'?: { nowplaying?: string }
}

interface RecentResponse {
  recenttracks?: {
    track?: RawTrack | RawTrack[]
    '@attr'?: { total?: string; totalPages?: string }
  }
  error?: number
  message?: string
}

// Prefer the largest art Last.fm offers, falling back down the list.
function pickImage(images?: RawImage[]): string | null {
  if (!Array.isArray(images)) return null
  for (const size of ['extralarge', 'large', 'medium', 'small']) {
    const hit = images.find((i) => i.size === size && i['#text'])
    if (hit) return hit['#text']
  }
  return images.find((i) => i['#text'])?.['#text'] ?? null
}

export interface FetchRecentOptions {
  apiKey: string
  user: string
  limit?: number
  page?: number
  /** Unix seconds — only return scrobbles at or after this time. */
  from?: number
  /** Unix seconds — only return scrobbles at or before this time. */
  to?: number
}

export async function fetchRecentTracks(opts: FetchRecentOptions): Promise<RecentResult> {
  const params = new URLSearchParams({
    method: 'user.getrecenttracks',
    user: opts.user,
    api_key: opts.apiKey,
    format: 'json',
    extended: '1',
    limit: String(opts.limit ?? 50),
    page: String(opts.page ?? 1),
  })
  if (opts.from) params.set('from', String(opts.from))
  if (opts.to) params.set('to', String(opts.to))

  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { 'user-agent': 'cailinpitt.com-listening/1.0 (+https://cailinpitt.com)' },
  })
  if (!res.ok) {
    throw new Error(`Last.fm HTTP ${res.status}: ${await res.text()}`)
  }

  const data = (await res.json()) as RecentResponse
  if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message ?? ''}`)

  const rt = data.recenttracks
  const raw = rt?.track ? (Array.isArray(rt.track) ? rt.track : [rt.track]) : []

  let nowPlaying: NowPlaying | null = null
  const scrobbles: Scrobble[] = []
  for (const t of raw) {
    const base: NowPlaying = {
      track: t.name,
      artist: t.artist?.name ?? t.artist?.['#text'] ?? '',
      album: t.album?.['#text'] || null,
      mbid: t.mbid || null,
      image: pickImage(t.image),
    }
    // A dateless row is the live "now playing" track — never a stored scrobble.
    if (t['@attr']?.nowplaying === 'true' || !t.date) {
      if (!nowPlaying) nowPlaying = base
      continue
    }
    scrobbles.push({ ...base, uts: Number(t.date.uts) })
  }

  return {
    nowPlaying,
    scrobbles,
    total: Number(rt?.['@attr']?.total ?? scrobbles.length),
    totalPages: Number(rt?.['@attr']?.totalPages ?? 1),
  }
}

// ---- enrichment ----------------------------------------------------------

export interface RawTag {
  name: string
  count: number
}

async function call<T>(params: Record<string, string>, apiKey: string): Promise<T> {
  const query = new URLSearchParams({ ...params, api_key: apiKey, format: 'json' })
  const res = await fetch(`${ENDPOINT}?${query.toString()}`, {
    headers: { 'user-agent': 'cailinpitt.com-listening/1.0 (+https://cailinpitt.com)' },
  })
  if (!res.ok) throw new Error(`Last.fm HTTP ${res.status}`)
  return (await res.json()) as T
}

/**
 * An artist's genre tags.
 *
 * Returns [] rather than throwing when Last.fm simply has nothing for an artist
 * — a real outcome for obscure names, and one the caller records so it isn't
 * retried every tick forever. Error 6 is "not found", which is not a failure.
 */
export async function fetchArtistTags(
  apiKey: string,
  artist: string,
): Promise<{ tags: RawTag[]; found: boolean }> {
  const data = await call<{
    toptags?: { tag?: { name: string; count: number }[] | { name: string; count: number } }
    error?: number
  }>({ method: 'artist.gettoptags', artist }, apiKey)

  if (data.error === 6) return { tags: [], found: false }
  if (data.error) throw new Error(`Last.fm error ${data.error}`)

  const raw = data.toptags?.tag
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : []
  return {
    tags: list.map((t) => ({ name: String(t.name), count: Number(t.count) || 0 })),
    found: true,
  }
}

export interface AlbumInfo {
  tags: RawTag[]
  /** Every track on the record, with its duration in seconds where known. */
  tracks: { name: string; duration: number | null }[]
  found: boolean
}

/**
 * One album's tags and the durations of every track on it.
 *
 * This is the reason durations are affordable: 8,854 album calls cover all
 * 18,114 distinct tracks, where track.getInfo would need one call each.
 */
export async function fetchAlbumInfo(
  apiKey: string,
  artist: string,
  album: string,
): Promise<AlbumInfo> {
  const data = await call<{
    album?: {
      tags?: { tag?: { name: string; count?: number }[] | { name: string; count?: number } }
      tracks?: { track?: { name: string; duration?: string | number }[] | { name: string; duration?: string | number } }
    }
    error?: number
  }>({ method: 'album.getinfo', artist, album }, apiKey)

  if (data.error === 6) return { tags: [], tracks: [], found: false }
  if (data.error) throw new Error(`Last.fm error ${data.error}`)

  const a = data.album
  const rawTags = a?.tags?.tag
  const tagList = rawTags ? (Array.isArray(rawTags) ? rawTags : [rawTags]) : []
  const rawTracks = a?.tracks?.track
  const trackList = rawTracks ? (Array.isArray(rawTracks) ? rawTracks : [rawTracks]) : []

  return {
    // Album tags carry no weight, so they all count equally.
    tags: tagList.map((t) => ({ name: String(t.name), count: Number(t.count) || 1 })),
    tracks: trackList.map((t) => {
      const seconds = Number(t.duration)
      // 0 is Last.fm's "unknown", not a zero-length track.
      return { name: String(t.name), duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null }
    }),
    found: true,
  }
}
