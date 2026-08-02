import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { imageUrl, photoYearBreaks, type Photo, yearAnchor } from '../lib/photos'
import { pageSchema } from '../lib/structuredData'

// The feed: every photograph on the site in one square grid, newest first.
//
// There is no pagination and no infinite scroll — all of them are in the
// prerendered html, and `loading="lazy"` means the browser only fetches the few
// screens' worth it actually needs. That keeps the page working without
// JavaScript, keeps Cmd-F useful, and keeps the year anchors real links.

/**
 * What a tile needs, and nothing else. The full manifest entry carries capture
 * metadata and dates that only a photo's own page shows, and this list is five
 * hundred long — carrying those into the prerendered loader data would double it
 * for nothing.
 */
type FeedPhoto = Pick<Photo, 'id' | 'src' | 'thumb' | 'alt' | 'year' | 'width' | 'height'>

const toTile = ({ id, src, thumb, alt, year, width, height }: Photo): FeedPhoto => ({
  id,
  src,
  thumb,
  alt,
  year,
  width,
  height,
})

export async function loader(): Promise<FeedPhoto[] | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    return (await import('../lib/content.client')).loadPhotos().map(toTile)
  }
  const { loadPhotos } = await import('../lib/content.server')
  return (await loadPhotos()).map(toTile)
}

export function Component() {
  const photos = useLoaderData() as FeedPhoto[]
  const count = photos.length
  // Which tiles start a new year. They carry the only anchors on the page, so
  // /photos#y2019 still lands somewhere sensible now that /2019 is gone.
  const breaks = photoYearBreaks(photos)
  const description = 'Photographs by Cailin Pitt.'

  return (
    <div className="photos">
      <Seo
        title="Photos"
        description={description}
        path="/photos"
        card={{
          kicker: 'Photographs',
          meta: `${count} ${count === 1 ? 'photograph' : 'photographs'}`,
          photo: photos[0] ? imageUrl(photos[0].src) : undefined,
        }}
        jsonLd={pageSchema({
          path: '/photos',
          title: 'Photos',
          description,
          image: photos[0]?.src,
          type: 'ImageGallery',
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

      {count === 0 ? (
        <p className="photos-empty">Photos coming soon.</p>
      ) : (
        <ul className="photo-feed">
          {photos.map((photo) => (
            <li key={photo.id} id={breaks.has(photo.id) ? yearAnchor(photo.year) : undefined}>
              <Link to={`/photos/${photo.id}`}>
                <img
                  // Tiles are square and ~200px wide at most, so the 1000px grid
                  // rendition is what should load here; the full size belongs to
                  // the photo's own page.
                  src={imageUrl(photo.thumb ?? photo.src)}
                  alt={photo.alt}
                  width={photo.width}
                  height={photo.height}
                  loading="lazy"
                  decoding="async"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
