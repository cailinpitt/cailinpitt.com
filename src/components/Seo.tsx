import { Head } from 'vite-react-ssg'

const SITE_URL = 'https://cailinpitt.com'
const SITE_NAME = 'Cailin Pitt'

interface SeoProps {
  title: string
  description?: string
  /** Page path, e.g. /blog/2023/3/3/slug. Used for canonical + og:url. */
  path?: string
  /** Absolute or root-relative image path for social cards. */
  image?: string
  type?: 'website' | 'article'
}

/**
 * Per-page <title>, meta description, canonical, and Open Graph / Twitter tags.
 * Covers the build-time metadata items from specification.website. Rendered into
 * <head> at prerender time by vite-react-ssg's <Head>.
 */
export function Seo({ title, description, path = '/', image, type = 'website' }: SeoProps) {
  const url = `${SITE_URL}${path}`
  const fullTitle = path === '/' ? title : `${title} — ${SITE_NAME}`
  const img = image ? (image.startsWith('http') ? image : `${SITE_URL}${image}`) : undefined

  return (
    <Head>
      <title>{fullTitle}</title>
      {description && <meta name="description" content={description} />}
      <link rel="canonical" href={url} />

      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={fullTitle} />
      {description && <meta property="og:description" content={description} />}
      <meta property="og:url" content={url} />
      {img && <meta property="og:image" content={img} />}

      <meta name="twitter:card" content={img ? 'summary_large_image' : 'summary'} />
      <meta name="twitter:title" content={fullTitle} />
      {description && <meta name="twitter:description" content={description} />}
      {img && <meta name="twitter:image" content={img} />}
    </Head>
  )
}
