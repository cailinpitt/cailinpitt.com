// All site images (blog inline images + photo galleries) are served from Cloudflare R2
// via this custom domain — none are committed to the repo. Root-relative `/images/...`
// paths (as stored in markdown and the gallery manifest) are rewritten to absolute R2
// URLs at render time. Other URLs (already absolute, data:, etc.) pass through unchanged.
const IMAGES_BASE = 'https://images.cailinpitt.com'

export function imageUrl(src?: string): string | undefined {
  if (!src) return src
  return src.startsWith('/images/') ? IMAGES_BASE + src : src
}
