import { imageUrl } from './images'
import { formatPhotoDate, type Photo } from './photos'
import { hasReadingEstimate, readingMinutes, type Post, type PostSummary } from './posts'

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

/** Newest-first list of posts, shared by the blog index and the tag pages. */
const itemListNode = (id: string, posts: PostSummary[]): Json => ({
  '@type': 'ItemList',
  '@id': id,
  itemListOrder: 'https://schema.org/ItemListOrderDescending',
  numberOfItems: posts.length,
  itemListElement: posts.map((post, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    url: abs(post.path),
    name: post.title,
  })),
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

/**
 * A single photograph's page. The photo is the point of the page, so it goes out
 * as a real ImageObject rather than only as the page's primary image.
 *
 * `dateCreated` is emitted only for a photo with a capture time. Most of the
 * archive carries an approximate date good to the year (see src/lib/photos.ts),
 * and a schema consumer has no way to know that — better to say nothing than to
 * publish a day that was never a day.
 */
export function photoSchema(photo: Photo): Json {
  const path = `/photos/${photo.id}`
  const url = abs(path)
  const imageId = `${url}#photo`
  const page = pageNode({ path, title: formatPhotoDate(photo), description: photo.alt, image: photo.src })
  page.mainEntity = ref(imageId)

  return graph(personNode(), websiteNode(), page, {
    '@type': 'ImageObject',
    '@id': imageId,
    contentUrl: imageUrl(photo.src),
    name: formatPhotoDate(photo),
    description: photo.alt,
    creator: ref(PERSON_ID),
    mainEntityOfPage: ref(`${url}#webpage`),
    ...(photo.approx ? {} : { dateCreated: photo.date }),
    ...(photo.width ? { width: photo.width } : {}),
    ...(photo.height ? { height: photo.height } : {}),
  })
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

  return graph(personNode(), websiteNode(), blog, page, itemListNode(listId, posts))
}

/** A `/blog/tag/<slug>` page: the same shape as the index, narrowed to one tag. */
export function blogTagSchema(label: string, path: string, posts: PostSummary[]): Json {
  const listId = `${abs(path)}#posts`
  const page = pageNode({
    path,
    title: `Posts tagged “${label}”`,
    description: `Writing by ${AUTHOR} tagged “${label}”.`,
    type: 'CollectionPage',
  })
  page.about = ref(BLOG_ID)
  page.mainEntity = ref(listId)

  return graph(personNode(), websiteNode(), blogNode(), page, itemListNode(listId, posts))
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
      // wordCount is measured, so it goes out whenever there is one. timeRequired
      // is the same estimate the page shows, as an ISO 8601 duration — so it is
      // held to the same threshold, and the two can never disagree.
      ...(post.words ? { wordCount: post.words } : {}),
      ...(hasReadingEstimate(post.words) ? { timeRequired: `PT${readingMinutes(post.words)}M` } : {}),
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
