// All site images are served from Cloudflare R2 via this custom domain, none committed to
// the repo. Root-relative `/images/...` paths are rewritten to absolute R2 URLs; other URLs pass through.
const IMAGES_BASE = 'https://images.cailinpitt.com'

export function imageUrl(src?: string): string | undefined {
  if (!src) return src
  return src.startsWith('/images/') ? IMAGES_BASE + src : src
}
