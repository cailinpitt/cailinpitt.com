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
