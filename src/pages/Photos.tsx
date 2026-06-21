import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { imageUrl } from '../lib/galleries'
import type { GallerySummary } from '../lib/content.server'
import { pageSchema } from '../lib/structuredData'

export async function loader(): Promise<GallerySummary[] | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    return (await import('../lib/content.client')).loadGallerySummaries()
  }
  const { loadGallerySummaries } = await import('../lib/content.server')
  return loadGallerySummaries()
}

export function Component() {
  const galleries = useLoaderData() as GallerySummary[]
  // Skip alias galleries (e.g. /past-work, which mirrors /2022).
  const years = galleries.filter((g) => !g.canonicalPath)

  return (
    <div className="gallery">
      <Seo
        title="Photos"
        description="Photography by Cailin Pitt — yearly archives."
        path="/photos"
        jsonLd={pageSchema({
          path: '/photos',
          title: 'Photos',
          description: 'Photography by Cailin Pitt — yearly archives.',
          type: 'CollectionPage',
        })}
      />
      <h1>Photos</h1>
      <ul className="gallery-index">
        {years.map((g) => {
          const cover = g.cover
          return (
            <li key={g.path}>
              <Link to={g.path}>
                {cover && (
                  <img
                    src={imageUrl(cover.src)}
                    alt=""
                    width={cover.width}
                    height={cover.height}
                    loading="lazy"
                    decoding="async"
                  />
                )}
                <span className="gallery-index-label">{g.title}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
