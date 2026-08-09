import { Head } from 'vite-react-ssg'

const SITE_URL = 'https://cailinpitt.com'
const SITE_NAME = 'Cailin Pitt'

/**
 * What only the page itself knows about its social card. Emitted as a hint for
 * scripts/generate-og.mjs, which renders the card from the built HTML at deploy
 * time; everything else on the card (title, description) it reads off the tags
 * below, so the two can't drift apart.
 */
interface OgCard {
  /** Section label in the card's top-right. Defaults to one derived from the path. */
  kicker?: string
  /** Footer line — a post's date and reading time, a gallery's photo count. */
  meta?: string
  /** Absolute URL of a photograph to run full-bleed behind the title. */
  photo?: string
  /** Opt out of the paper card for a layout of the page's own. */
  layout?: 'terminal'
}

interface SeoProps {
  title: string
  description?: string
  /** Page path, e.g. /blog/2023/3/3/slug. Used for canonical + og:url. */
  path?: string
  /**
   * Override the social card. Pages don't normally set this: each one gets a
   * generated card at /og<path>.jpg. Absolute or root-relative.
   */
  image?: string
  imageAlt?: string
  /** Page-specific details for the generated card. */
  card?: OgCard
  type?: 'website' | 'article'
  /** schema.org JSON-LD to embed (a single object or an array of them). */
  jsonLd?: object | object[]
  /** AT-URI of the site.standard.publication record (standard.site, Phase 8). */
  publicationUri?: string | null
  /** AT-URI of this page's site.standard.document record (standard.site, Phase 8). */
  documentUri?: string | null
  /**
   * Path of this page's published Markdown source, if it has one. Advertised as
   * an alternate representation so a crawler or a reader that would rather have
   * the source than the page can find it without being told.
   */
  markdownPath?: string
  /**
   * An RSS feed this page is the human view of, advertised for autodiscovery.
   *
   * index.html already carries the site's own /feed.xml on every page. This is
   * for a feed belonging to *one* page — /notes, whose feed is served by its
   * Worker rather than written at build time — which has no business being
   * advertised from the front page or from every post.
   */
  feed?: { href: string; title: string }
  /**
   * Keep this page out of search results and out of sitemap.xml.
   *
   * For pages that exist but aren't publications: /notes/compose is a writing
   * tool, not a thing to read. scripts/generate-sitemap.mjs reads the emitted
   * meta tag rather than being told separately, so a page can't be noindex and
   * still get submitted.
   */
  noindex?: boolean
}

// Escape `<` so the serialized JSON can't break out of the <script> element.
const serializeJsonLd = (data: object | object[]) =>
  JSON.stringify(data).replace(/</g, '\\u003c')

/**
 * Where this page's generated card lives. Mirrors cardFile() in
 * scripts/generate-og.mjs — the two must agree, or pages point at a 404.
 */
const ogCardPath = (path: string) => `/og/${path === '/' ? 'index' : path.replace(/^\//, '')}.jpg`

/**
 * Per-page <title>, meta description, canonical, and Open Graph / Twitter tags.
 * Covers the build-time metadata items from specification.website. Rendered into
 * <head> at prerender time by vite-react-ssg's <Head>.
 */
export function Seo({
  title,
  description,
  path = '/',
  image,
  imageAlt,
  card,
  type = 'website',
  jsonLd,
  publicationUri,
  documentUri,
  markdownPath,
  feed,
  noindex,
}: SeoProps) {
  const url = `${SITE_URL}${path}`
  const fullTitle = path === '/' ? title : `${title} — ${SITE_NAME}`
  const src = image ?? ogCardPath(path)
  const img = src.startsWith('http') ? src : `${SITE_URL}${src}`
  // Our own cards are 1200x630 whether this page generated one or is reusing
  // another page's, so the dimensions follow the *image*, not whether it was
  // supplied. A page passing a photograph declares nothing, since it isn't.
  const isOgCard = src.startsWith('/og/') || src.startsWith(`${SITE_URL}/og/`)
  // Whether *this page* gets a card rendered for it. A page reusing another's
  // has nothing to hint about, so the build-time hint below is suppressed.
  const generated = !image

  return (
    <Head>
      <title>{fullTitle}</title>
      {description && <meta name="description" content={description} />}
      {noindex && <meta name="robots" content="noindex, nofollow" />}
      <link rel="canonical" href={url} />
      {feed && (
        <link rel="alternate" type="application/rss+xml" href={feed.href} title={feed.title} />
      )}
      {markdownPath && (
        <link
          rel="alternate"
          type="text/markdown"
          href={`${SITE_URL}${markdownPath}`}
          title="Markdown source"
        />
      )}

      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={fullTitle} />
      {description && <meta property="og:description" content={description} />}
      <meta property="og:url" content={url} />
      <meta property="og:image" content={img} />
      <meta property="og:image:alt" content={imageAlt ?? fullTitle} />
      {isOgCard && <meta property="og:image:width" content="1200" />}
      {isOgCard && <meta property="og:image:height" content="630" />}

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      {description && <meta name="twitter:description" content={description} />}
      <meta name="twitter:image" content={img} />
      <meta name="twitter:image:alt" content={imageAlt ?? fullTitle} />

      {/* Build-time hint for scripts/generate-og.mjs; ignored by everything else. */}
      {generated && card && <meta name="og-card" content={JSON.stringify(card)} />}

      {jsonLd && (
        <script type="application/ld+json">{serializeJsonLd(jsonLd)}</script>
      )}

      {/* standard.site: link this page to its AT Protocol records (Phase 8). */}
      {publicationUri && <link rel="site.standard.publication" href={publicationUri} />}
      {documentUri && <link rel="site.standard.document" href={documentUri} />}
    </Head>
  )
}
