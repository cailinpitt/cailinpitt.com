import { Link } from 'react-router-dom'
import { imageUrl, type PhotoPreview } from '../lib/photos'

/** A row of recent photographs linking into the feed (homepage strip, and the foot of /now). Grid is `auto-fill`; how many to show is the caller's call. */
export function PhotoStrip({ photos }: { photos: PhotoPreview[] }) {
  if (!photos.length) return null

  return (
    <ul className="photo-previews">
      {photos.map((photo) => (
        <li key={photo.href}>
          <Link
            to={photo.href}
            aria-label={`Photo — ${photo.label}`}
            // The photo's own color underneath, as on the feed tiles.
            style={photo.tint ? { background: photo.tint } : undefined}
          >
            {/* Tiles cap at 130px (.photo-previews) — srcset/sizes avoid fetching a 1000px rendition for a thumbnail. */}
            <img
              src={imageUrl(photo.src)}
              srcSet={photo.srcset}
              sizes={photo.srcset ? '130px' : undefined}
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span className="photo-preview-label">{photo.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
