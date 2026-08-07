// MusicBrainz client: where an artist is from, what kind of act they are, and
// when they started.
//
// MusicBrainz asks for **one request per second** and a User-Agent identifying
// the application with contact info. Both are honored — the backfill script
// paces itself, and the cron only ever makes one or two calls per tick.
//
// Two ways in, in order of accuracy:
//
//  1. Lookup by MBID. Exact. The MBID comes from Last.fm's artist.getInfo, which
//     is cheap and fast, so the extra call is worth it.
//  2. Search by name. A fallback, and a fuzzy one — "Nirvana" alone matches a
//     dozen acts. The score threshold below is what keeps the worst of that out.

const MB = 'https://musicbrainz.org/ws/2'

/** MusicBrainz requires a descriptive UA with a contact URL. */
const UA = 'cailinpitt.com-listening/1.0 (+https://cailinpitt.com)'

/**
 * Minimum search score to accept a name match.
 *
 * MusicBrainz scores 0–100. Below this the match is usually a different act
 * with a similar name, and a wrong country is worse than no country — it would
 * silently distort the map rather than just leaving a gap.
 */
const MIN_SCORE = 90

/**
 * Manual corrections, applied when the origin lookup map is built.
 *
 * Neither resolution path is reliable for artists whose name is shared by
 * another act. Last.fm's MBID is a curated link and usually right, but not
 * always: it resolves "Turnstile" to a Spanish group rather than the Baltimore
 * hardcore band, and the name search can't tell them apart either. There is no
 * automatic fix — disambiguating needs a human who knows which band was meant.
 *
 * So: correct them here. This is applied in buildOriginMap(), not at fetch time,
 * so adding a row costs a redeploy and a lookup rebuild rather than a re-fetch.
 * Delete `meta:v1:built-at` from KV to force the rebuild immediately.
 *
 * `formedYear` is only meaningful for a Group — see the note in aggregate.ts.
 */
export const ORIGIN_OVERRIDES: Record<
  string,
  { country: string | null; kind: string | null; formedYear: number | null }
> = {
  Turnstile: { country: 'US', kind: 'Group', formedYear: 2010 },
}

export interface ArtistOrigin {
  mbid: string | null
  /** ISO 3166-1 alpha-2, or null when MusicBrainz doesn't know. */
  country: string | null
  /** 'Group', 'Person', 'Orchestra', … */
  kind: string | null
  formedYear: number | null
  found: boolean
}

const EMPTY: ArtistOrigin = { mbid: null, country: null, kind: null, formedYear: null, found: false }

async function get<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } })
  // 404 is a real answer: that MBID isn't in MusicBrainz.
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`)
  return (await res.json()) as T
}

interface MBArtist {
  id?: string
  name?: string
  country?: string
  area?: { 'iso-3166-1-codes'?: string[] }
  'begin-area'?: { 'iso-3166-1-codes'?: string[] }
  type?: string
  'life-span'?: { begin?: string }
  score?: number
}

/**
 * Read the fields we care about off an artist document.
 *
 * `country` is often absent even when the area is known, so fall back through
 * area then begin-area — that recovers a country for a good number of acts.
 */
function shape(artist: MBArtist): ArtistOrigin {
  const country =
    artist.country ??
    artist.area?.['iso-3166-1-codes']?.[0] ??
    artist['begin-area']?.['iso-3166-1-codes']?.[0] ??
    null

  // life-span.begin is 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD'; only the year matters.
  const begin = artist['life-span']?.begin
  const year = begin ? Number(begin.slice(0, 4)) : NaN

  return {
    mbid: artist.id ?? null,
    country,
    kind: artist.type ?? null,
    formedYear: Number.isFinite(year) && year > 1800 && year <= 2100 ? year : null,
    found: true,
  }
}

/** Exact lookup by MBID. */
export async function lookupArtist(mbid: string): Promise<ArtistOrigin> {
  const data = await get<MBArtist>(`${MB}/artist/${encodeURIComponent(mbid)}?fmt=json`)
  return data ? shape(data) : EMPTY
}

/** Fuzzy lookup by name, used only when there is no MBID. */
export async function searchArtist(name: string): Promise<ArtistOrigin> {
  const query = encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`)
  const data = await get<{ artists?: MBArtist[] }>(`${MB}/artist?query=${query}&fmt=json&limit=1`)
  const hit = data?.artists?.[0]
  if (!hit) return EMPTY
  // A low-confidence match is recorded as "looked, found nothing" rather than
  // guessed at, so the queue doesn't retry it and the map doesn't lie.
  if ((hit.score ?? 0) < MIN_SCORE) return EMPTY
  return shape(hit)
}

/**
 * Resolve one artist, preferring the exact path.
 *
 * `lastfmMbid` comes from Last.fm's artist.getInfo. It is frequently absent or
 * stale, so a 404 on it falls through to the name search rather than giving up.
 */
export async function resolveArtist(
  name: string,
  lastfmMbid?: string | null,
): Promise<ArtistOrigin> {
  if (lastfmMbid) {
    const byId = await lookupArtist(lastfmMbid)
    if (byId.found) return byId
  }
  return searchArtist(name)
}
