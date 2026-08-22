export async function sha256Hex(input: string, length = 64): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}

// CF-Connecting-IP can't be spoofed by the client. Empty only under `wrangler
// dev`, where every request shares one rate-limit bucket.
export function ipHash(request: Request, salt: string): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? ''
  return sha256Hex(`${ip}:${salt}`, 32)
}

export function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
