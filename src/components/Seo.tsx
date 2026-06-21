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
  imageAlt?: string
  type?: 'website' | 'article'
  /** schema.org JSON-LD to embed (a single object or an array of them). */
  jsonLd?: object | object[]
  /** AT-URI of the site.standard.publication record (standard.site, Phase 8). */
  publicationUri?: string | null
  /** AT-URI of this page's site.standard.document record (standard.site, Phase 8). */
  documentUri?: string | null
}

// Escape `<` so the serialized JSON can't break out of the <script> element.
const serializeJsonLd = (data: object | object[]) =>
  JSON.stringify(data).replace(/</g, '\\u003c')

/**
 * Per-page <title>, meta description, canonical, and Open Graph / Twitter tags.
 * Covers the build-time metadata items from specification.website. Rendered into
 * <head> at prerender time by vite-react-ssg's <Head>.
 */
export function Seo({
  title,
  description,
  path = '/',
  image = '/social-card.png',
  imageAlt,
  type = 'website',
  jsonLd,
  publicationUri,
  documentUri,
}: SeoProps) {
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
      {img && <meta property="og:image:alt" content={imageAlt ?? fullTitle} />}
      {image === '/social-card.png' && <meta property="og:image:width" content="1200" />}
      {image === '/social-card.png' && <meta property="og:image:height" content="630" />}

      <meta name="twitter:card" content={img ? 'summary_large_image' : 'summary'} />
      <meta name="twitter:title" content={fullTitle} />
      {description && <meta name="twitter:description" content={description} />}
      {img && <meta name="twitter:image" content={img} />}
      {img && <meta name="twitter:image:alt" content={imageAlt ?? fullTitle} />}

      {jsonLd && (
        <script type="application/ld+json">{serializeJsonLd(jsonLd)}</script>
      )}

      {/* standard.site: link this page to its AT Protocol records (Phase 8). */}
      {publicationUri && <link rel="site.standard.publication" href={publicationUri} />}
      {documentUri && <link rel="site.standard.document" href={documentUri} />}
    </Head>
  )
}
