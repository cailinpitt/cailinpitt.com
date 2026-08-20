// Turnstile verification — the load-bearing half of the spam defense. Other
// checks in the write path raise the cost of an attack; this is what stops a
// scripted loop entirely, since the widget token is single-use and short-lived
// so a captured request body can't be replayed.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Give up after this long, rather than hold the invocation open. */
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

// `remoteIp` is the real IP, not a hash — used only for this call, never
// stored (the hashing in hash.ts is about what gets stored). Fails closed: a
// network error or timeout returns ok:false, so an outage makes writes
// briefly fail rather than briefly open.
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
