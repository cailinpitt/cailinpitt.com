/** Truncated hex SHA-256. Same helper as the reading worker's. */
export async function sha256Hex(input: string, length = 64): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}

/**
 * The connecting IP, salted and hashed.
 *
 * Truncated to 32 hex chars (128 bits) — still far beyond collision range for a
 * table this size, and a reminder that this is an opaque bucket key rather than
 * a stored identity. CF-Connecting-IP is set by Cloudflare's edge and cannot be
 * spoofed by the client; the empty-string fallback only happens under
 * `wrangler dev`, where every local request shares one bucket (which is what you
 * want when testing the rate limit).
 */
export function ipHash(request: Request, salt: string): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? ''
  return sha256Hex(`${ip}:${salt}`, 32)
}

/** Opaque, unguessable entry id. 16 random bytes as hex. */
export function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
