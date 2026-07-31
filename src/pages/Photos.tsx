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
      <p className="photos-map-link">
        <Link to="/photos/map">
          {/* Stroked in currentColor like the other icons on the site — an emoji
              pin brings its own red and fights the palette. */}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" />
            <circle cx="12" cy="10" r="2.5" />
          </svg>
          Photo map
        </Link>
      </p>
      <ul className="gallery-index">
        {years.map((g) => {
          const cover = g.cover
          return (
            <li key={g.path}>
              <Link to={g.path}>
                {cover && (
                  <img
                    src={imageUrl(cover.thumb ?? cover.src)}
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
