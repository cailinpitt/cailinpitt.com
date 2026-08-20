// MusicBrainz client: where an artist is from, what kind of act, and when they
// started. Rate limit is 1 req/s (backfill script paces itself; cron makes 1-2
// calls/tick). Two ways in: exact lookup by MBID (from Last.fm's
// artist.getInfo), or a fuzzy name search as fallback, gated by MIN_SCORE.

const MB = 'https://musicbrainz.org/ws/2'

/** MusicBrainz requires a descriptive UA with a contact URL. */
const UA = 'cailinpitt.com-listening/1.0 (+https://cailinpitt.com)'

// Below this (0-100 scale) the match is usually a different act with a similar
// name — a wrong country silently distorts the map, worse than a gap.
const MIN_SCORE = 90

// Manual corrections for artists neither resolution path handles right (e.g.
// Last.fm's MBID resolves "Turnstile" to a Spanish group, not the Baltimore
// band) — needs a human, so fix it here. Applied in buildOriginMap(), not at
// fetch time, so a new row costs a redeploy + lookup rebuild, not a re-fetch;
// delete `meta:v1:built-at` from KV to force the rebuild immediately.
// `formedYear` only means anything for a Group — see the note in aggregate.ts.
export const ORIGIN_OVERRIDES: Record<
  string,
  { country: string | null; kind: string | null; formedYear: number | null }
> = {
  Turnstile: { country: 'US', kind: 'Group', formedYear: 2010 },
  "Her's": { country: 'GB', kind: 'Group', formedYear: 2015 },
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

// `country` is often absent even when the area is known, so fall back through
// area then begin-area to recover it for more acts.
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

// `lastfmMbid` is frequently absent or stale, so a 404 on it falls through to
// the name search rather than giving up.
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
