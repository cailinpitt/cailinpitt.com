// Client for the guestbook API (Cloudflare Worker in /worker-guestbook), fetched in the
// browser like /listening and /reading. Interfaces mirror the Worker's by hand — not a
// shared package, so a change on one side has to be made on the other.

const API_BASE = import.meta.env.VITE_GUESTBOOK_API ?? 'https://guestbook.cailinpitt.com'

// Turnstile *site* key — public by design, ships in the page HTML. Kept in sync by hand with
// TURNSTILE_SITE_KEY in worker-guestbook/wrangler.jsonc. Override with VITE_TURNSTILE_SITE_KEY
// to point a build at a different widget, e.g. Cloudflare's test key `1x00000000000000000000AA`.
export const TURNSTILE_SITE_KEY =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '0x4AAAAAAEEBNcQ83mO9Fcud'

/** Mirrors validate.ts's LIMITS. Used for maxLength and the character counter. */
export const LIMITS = {
  name: 60,
  message: 1000,
  location: 60,
  website: 200,
} as const

export interface Entry {
  id: string
  name: string
  message: string
  /** Normalized http(s) url, or null. */
  website: string | null
  location: string | null
  /** ISO-3166-1 alpha-2, filled in by Cloudflare from the request. */
  country: string | null
  /** Unix seconds. */
  createdAt: number
}

export interface EntryPage {
  entries: Entry[]
  /** Opaque; pass straight back to fetchOlderEntries. Null means no more. */
  nextCursor: string | null
  total: number
}

export interface SignPayload {
  name: string
  message: string
  website: string
  location: string
  token: string
  /** Honeypot. Always sent, always empty unless something automated filled it. */
  nickname: string
}

// `field` is present when the Worker could attribute the problem to one input, letting the
// form show the message inline.
export class SignError extends Error {
  readonly field?: keyof typeof LIMITS
  readonly status: number
  constructor(message: string, status: number, field?: keyof typeof LIMITS) {
    super(message)
    this.name = 'SignError'
    this.status = status
    this.field = field
  }
}

export async function fetchGuestbook(signal?: AbortSignal): Promise<EntryPage> {
  const res = await fetch(`${API_BASE}/guestbook.json`, { signal })
  if (!res.ok) throw new Error(`Guestbook API ${res.status}`)
  return res.json() as Promise<EntryPage>
}

export async function fetchOlderEntries(
  cursor: string,
  limit = 25,
  signal?: AbortSignal,
): Promise<EntryPage> {
  const res = await fetch(
    `${API_BASE}/guestbook.json?before=${encodeURIComponent(cursor)}&limit=${limit}`,
    { signal },
  )
  if (!res.ok) throw new Error(`Guestbook API ${res.status}`)
  return res.json() as Promise<EntryPage>
}

// Resolves to null when the Worker reports success without writing anything (a filled
// honeypot) — the form treats both as success, so a bot believes it worked.
export async function signGuestbook(payload: SignPayload): Promise<Entry | null> {
  const res = await fetch(`${API_BASE}/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; entry?: Entry | null; error?: string; field?: keyof typeof LIMITS }
    | null

  if (!res.ok) {
    throw new SignError(
      data?.error ?? 'Something went wrong. Try again in a moment.',
      res.status,
      data?.field,
    )
  }
  return data?.entry ?? null
}

// Built from regional indicator codepoints — no image assets, no lookup table. Null for
// anything that isn't two letters, including the nulls Cloudflare can't place an address for.
export function flagEmoji(code: string | null): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  )
}

/** "cailinpitt.com" from a stored URL — the readable form for a link's text. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
