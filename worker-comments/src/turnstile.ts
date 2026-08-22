const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TIMEOUT_MS = 5000

interface SiteVerifyResponse {
  success: boolean
  'error-codes'?: string[]
}

export interface TurnstileResult {
  ok: boolean
  codes: string[]
}

// Fails closed: a network error or timeout returns ok:false.
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
