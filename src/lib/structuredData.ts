import { imageUrl } from './images'
import type { Post } from './posts'

// schema.org JSON-LD builders. Kept separate from <Seo> so the shapes are easy to
// read and reuse. Emitted into <head> via <Seo jsonLd={...}> at prerender time.

const SITE_URL = 'https://cailinpitt.com'
const AUTHOR = 'Cailin Pitt'
const SAME_AS = ['https://github.com/CailinPitt']

type Json = Record<string, unknown>

const abs = (p: string) => (p.startsWith('http') ? p : `${SITE_URL}${p.startsWith('/') ? '' : '/'}${p}`)

const PERSON: Json = { '@type': 'Person', name: AUTHOR, url: SITE_URL }

/** First local image referenced in a post body (markdown or HTML), used as a cover fallback. */
export function firstImagePath(body: string): string | undefined {
  const md = body.match(/!\[[^\]]*\]\((\/images\/[^)\s]+)\)/)
  if (md) return md[1]
  const html = body.match(/<img[^>]+src=["'](\/images\/[^"']+)["']/i)
  return html?.[1]
}

export function personSchema(): Json {
  return { '@context': 'https://schema.org', ...PERSON, sameAs: SAME_AS }
}

export function websiteSchema(): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: AUTHOR,
    url: SITE_URL,
    description: 'Photography and writing by Cailin Pitt.',
  }
}

export function blogPostingSchema(post: Post): Json {
  const image = post.image ?? firstImagePath(post.body)
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    url: abs(post.path),
    mainEntityOfPage: abs(post.path),
    datePublished: post.date,
    dateModified: post.date,
    ...(post.description ? { description: post.description } : {}),
    ...(image ? { image: imageUrl(image) } : {}),
    ...(post.tags.length ? { keywords: post.tags.join(', ') } : {}),
    author: PERSON,
    publisher: PERSON,
  }
}

export function breadcrumbSchema(post: Post): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: abs('/blog') },
      { '@type': 'ListItem', position: 3, name: post.title, item: abs(post.path) },
    ],
  }
}
