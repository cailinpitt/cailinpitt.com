import { useEffect } from 'react'
import { Link, useNavigate, useParams, useLoaderData, type LoaderFunctionArgs } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { formatPhotoDate, imageUrl, photoNeighbors, yearAnchor, type Photo } from '../lib/photos'
import { formatSettings } from '../lib/exif'
import { photoSchema } from '../lib/structuredData'

// One photograph at its own permanent URL — replaced the gallery lightbox so a
// single frame can be linked, shared with its own social card, and prerendered.

interface PhotoPage {
  photo: Photo
  newer?: Photo
  older?: Photo
  /** 1-based position in the feed, for the "n of 484" line. */
  position: number
  total: number
}

export async function loader({ params }: LoaderFunctionArgs): Promise<PhotoPage | null> {
  if (!import.meta.env.SSR && !import.meta.env.DEV) return null
  const { loadPhotos } = import.meta.env.SSR
    ? await import('../lib/content.server')
    : await import('../lib/content.client')
  const photos = await loadPhotos()
  const { index, photo, newer, older } = photoNeighbors(photos, params.id ?? '')
  if (!photo) throw new Response('Not found', { status: 404 })
  return { photo, newer, older, position: index + 1, total: photos.length }
}

export function Component() {
  const data = useLoaderData() as PhotoPage
  const params = useParams()
  const navigate = useNavigate()
  const { photo, newer, older } = data
  const settings = formatSettings(photo.exif)
  const place = photo.exif?.place

  // ←/→ page through the feed. Bound to the document, not a focused element —
  // nothing to focus on a page that's mostly one photograph.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.key === 'ArrowLeft' ? newer : event.key === 'ArrowRight' ? older : null
      if (!target) return
      event.preventDefault()
      navigate(`/photos/${target.id}`)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, newer, older])

  const when = formatPhotoDate(photo)
  const title = `${when}${photo.exif?.camera ? ` · ${photo.exif.camera}` : ''}`

  return (
    <div className="photo-detail">
      <Seo
        title={when}
        description={photo.alt}
        path={`/photos/${params.id ?? photo.id}`}
        // The photograph is its own social card — also skips generate-og.mjs
        // rendering one per photo, which at this volume would dominate a deploy.
        image={imageUrl(photo.src)}
        imageAlt={photo.alt}
        jsonLd={photoSchema(photo)}
      />

      <p className="tag-eyebrow">
        <Link to={`/photos#${yearAnchor(photo.year)}`}>← All photos</Link>
      </p>

      <figure>
        <img
          src={imageUrl(photo.src)}
          alt={photo.alt}
          width={photo.width}
          height={photo.height}
          // Same placeholder color as the feed tile, so it sharpens into place rather than flashing.
          style={photo.tint ? { background: photo.tint } : undefined}
          // The one image the visitor came for: no lazy loading, and ask for it early.
          fetchPriority="high"
          decoding="async"
        />
        <figcaption>
          <span className="photo-when">{title}</span>
          {settings && <span className="photo-settings">{settings}</span>}
          {place && (
            <Link className="photo-place" to="/photos/map">
              {place[0].toFixed(2)}, {place[1].toFixed(2)}
            </Link>
          )}
          <span className="photo-position">
            {data.position} / {data.total}
          </span>
        </figcaption>
      </figure>

      <nav className="photo-nav" aria-label="More photos">
        {newer ? (
          <Link to={`/photos/${newer.id}`} rel="prev">
            ← Newer
          </Link>
        ) : (
          <span />
        )}
        {older ? (
          <Link to={`/photos/${older.id}`} rel="next">
            Older →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </div>
  )
}
