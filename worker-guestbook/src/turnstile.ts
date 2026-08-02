// Turnstile verification — the load-bearing half of the spam defense.
//
// Everything else in the write path (origin check, honeypot, rate limits) raises
// the cost of an attack. This is the part that makes a scripted submission loop
// not work at all: the token the widget hands the browser is single-use and
// short-lived, so a captured request body cannot be replayed, and obtaining a
// fresh token means actually running the challenge.
//
// Free and unmetered at any volume, which is why it is here rather than a
// homegrown proof-of-work.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * Give up on Cloudflare's own endpoint after this long. A hung verify would
 * otherwise hold the Worker invocation open for the platform's full limit.
 */
const TIMEOUT_MS = 5000

interface SiteVerifyResponse {
  success: boolean
  'error-codes'?: string[]
}

export interface TurnstileResult {
  ok: boolean
  /** Cloudflare's machine-readable reasons, for the log. Never shown to the user. */
  codes: string[]
}

/**
 * Verify a widget token.
 *
 * `remoteIp` is the real connecting IP rather than a hash: Cloudflare already
 * has it (it terminated the connection), it is used for this call only, and it
 * is never written down. The hashing in hash.ts is about what we *store*.
 *
 * Fails closed. A network error or a timeout returns `ok: false`, so a Turnstile
 * outage makes the guestbook briefly read-only instead of briefly open. That is
 * the right way round: the read path — the part everyone actually looks at —
 * doesn't touch this at all.
 */
export async function verifyTurnstile(
  token: unknown,
  secret: string,
  remoteIp: string | null,
): Promise<TurnstileResult> {
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return { ok: false, codes: ['missing-input-response'] }
  }

  const body = new FormData()
  body.append('secret', secret)
  body.append('response', token)
  if (remoteIp) body.append('remoteip', remoteIp)

  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, codes: [`http-${res.status}`] }
    const data = (await res.json()) as SiteVerifyResponse
    return { ok: data.success === true, codes: data['error-codes'] ?? [] }
  } catch (err) {
    return { ok: false, codes: [`fetch-failed:${String(err)}`] }
  }
}
