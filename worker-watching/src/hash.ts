/** Truncated hex SHA-256. Used for R2 object keys. */
export async function sha256Hex(input: string, length = 64): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}
