import { imageUrl } from './images'
import type { Post, PostSummary } from './posts'

// Connected schema.org JSON-LD graphs. Stable @ids let each page describe how
// its Person, WebSite, Blog, WebPage, and content nodes relate to one another.

const SITE_URL = 'https://cailinpitt.com'
const AUTHOR = 'Cailin Pitt'
const LANGUAGE = 'en-US'
const PERSON_ID = `${SITE_URL}/#person`
const WEBSITE_ID = `${SITE_URL}/#website`
const BLOG_ID = `${SITE_URL}/blog#blog`
const SAME_AS = ['https://github.com/cailinpitt']

type Json = Record<string, unknown>

interface PageSchemaOptions {
  path: string
  title: string
  description?: string
  image?: string
  type?: 'WebPage' | 'CollectionPage' | 'ImageGallery'
}

const abs = (path: string) =>
  path.startsWith('http') ? path : `${SITE_URL}${path.startsWith('/') ? '' : '/'}${path}`

const ref = (id: string): Json => ({ '@id': id })

const personNode = (): Json => ({
  '@type': 'Person',
  '@id': PERSON_ID,
  name: AUTHOR,
  url: SITE_URL,
  description: 'Artist, software engineer, and occasional writer.',
  sameAs: SAME_AS,
})

const websiteNode = (): Json => ({
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  url: SITE_URL,
  name: AUTHOR,
  description: 'Photography, software projects, and writing by Cailin Pitt.',
  inLanguage: LANGUAGE,
  publisher: ref(PERSON_ID),
})

const blogNode = (): Json => ({
  '@type': 'Blog',
  '@id': BLOG_ID,
  url: abs('/blog'),
  name: `${AUTHOR}'s Blog`,
  description: 'Writing by Cailin Pitt.',
  inLanguage: LANGUAGE,
  isPartOf: ref(WEBSITE_ID),
  publisher: ref(PERSON_ID),
})

const graph = (...nodes: Json[]): Json => ({
  '@context': 'https://schema.org',
  '@graph': nodes,
})

const pageNode = ({ path, title, description, image, type = 'WebPage' }: PageSchemaOptions): Json => {
  const url = abs(path)
  return {
    '@type': type,
    '@id': `${url}#webpage`,
    url,
    name: title,
    inLanguage: LANGUAGE,
    isPartOf: ref(WEBSITE_ID),
    ...(description ? { description } : {}),
    ...(image
      ? {
          primaryImageOfPage: {
            '@type': 'ImageObject',
            url: imageUrl(image),
          },
        }
      : {}),
  }
}

/** First local image referenced in a post body (markdown or HTML), used as a cover fallback. */
export function firstImagePath(body: string): string | undefined {
  const md = body.match(/!\[[^\]]*\]\((\/images\/[^)\s]+)\)/)
  if (md) return md[1]
  const html = body.match(/<img[^>]+src=["'](\/images\/[^"']+)["']/i)
  return html?.[1]
}

export function homeSchema(): Json {
  const homeId = `${SITE_URL}/#webpage`
  return graph(
    personNode(),
    websiteNode(),
    {
      '@type': 'ProfilePage',
      '@id': homeId,
      url: `${SITE_URL}/`,
      name: AUTHOR,
      description: 'Photography, software projects, and writing by Cailin Pitt.',
      inLanguage: LANGUAGE,
      isPartOf: ref(WEBSITE_ID),
      mainEntity: ref(PERSON_ID),
    },
  )
}

export function pageSchema(options: PageSchemaOptions): Json {
  return graph(personNode(), websiteNode(), pageNode(options))
}

export function blogIndexSchema(posts: PostSummary[]): Json {
  const pageId = `${abs('/blog')}#webpage`
  const listId = `${abs('/blog')}#posts`
  const page = pageNode({
    path: '/blog',
    title: 'Blog',
    description: 'Writing by Cailin Pitt.',
    type: 'CollectionPage',
  })
  page.about = ref(BLOG_ID)
  page.mainEntity = ref(listId)
  const blog = blogNode()
  blog.mainEntityOfPage = ref(pageId)
  blog.blogPost = posts.map((post) => ref(`${abs(post.path)}#blogposting`))

  return graph(
    personNode(),
    websiteNode(),
    blog,
    page,
    {
      '@type': 'ItemList',
      '@id': listId,
      itemListOrder: 'https://schema.org/ItemListOrderDescending',
      numberOfItems: posts.length,
      itemListElement: posts.map((post, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        url: abs(post.path),
        name: post.title,
      })),
    },
  )
}

export function blogPostSchema(post: Post): Json {
  const url = abs(post.path)
  const webpageId = `${url}#webpage`
  const postingId = `${url}#blogposting`
  const breadcrumbId = `${url}#breadcrumb`
  const image = post.image ?? firstImagePath(post.body)

  const webpage = pageNode({
    path: post.path,
    title: post.title,
    description: post.description,
    image,
  })
  webpage.breadcrumb = ref(breadcrumbId)
  webpage.mainEntity = ref(postingId)

  return graph(
    personNode(),
    websiteNode(),
    blogNode(),
    webpage,
    {
      '@type': 'BlogPosting',
      '@id': postingId,
      url,
      headline: post.title,
      inLanguage: LANGUAGE,
      mainEntityOfPage: ref(webpageId),
      isPartOf: ref(BLOG_ID),
      datePublished: post.date,
      ...(post.updated ? { dateModified: post.updated } : {}),
      ...(post.description ? { description: post.description } : {}),
      ...(image
        ? {
            image: {
              '@type': 'ImageObject',
              '@id': `${url}#blogposting-image`,
              url: imageUrl(image),
            },
          }
        : {}),
      ...(post.tags.length
        ? { articleSection: post.tags[0], keywords: post.tags.join(', ') }
        : {}),
      author: ref(PERSON_ID),
      publisher: ref(PERSON_ID),
    },
    {
      '@type': 'BreadcrumbList',
      '@id': breadcrumbId,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: abs('/blog') },
        { '@type': 'ListItem', position: 3, name: post.title, item: url },
      ],
    },
  )
}
