import { Link } from 'react-router-dom'
import { imageUrl, type PhotoPreview } from '../lib/photos'

/**
 * A row of recent photographs linking into the feed — the homepage's strip, and
 * the one at the foot of the live block on /now.
 *
 * The grid is `auto-fill`, so it lays out whatever it's given; how many photos
 * to show is the caller's decision, not this component's.
 */
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
            <img src={imageUrl(photo.src)} alt="" loading="lazy" decoding="async" />
            <span className="photo-preview-label">{photo.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
