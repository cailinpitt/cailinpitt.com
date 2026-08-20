import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData } from 'react-router-dom'
import 'leaflet/dist/leaflet.css'
import { Seo } from '../components/Seo'
import { formatPhotoDate, imageUrl, type Photo } from '../lib/photos'
import { pageSchema } from '../lib/structuredData'

// Leaflet + OpenStreetMap tiles: free, no key. Leaflet touches `window` on
// import, so it's dynamically imported inside the effect (browser-only) rather
// than at the top level, which would break prerendering.

interface MapData {
  photos: Photo[]
}

export async function loader(): Promise<MapData | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    const { loadPhotos } = await import('../lib/content.client')
    return { photos: loadPhotos().filter((photo) => photo.exif?.place) }
  }
  const { loadPhotos } = await import('../lib/content.server')
  return { photos: (await loadPhotos()).filter((photo) => photo.exif?.place) }
}

/** Photos sharing a rounded coordinate, so overlapping pins become one marker. */
interface Pin {
  key: string
  lat: number
  lon: number
  photos: Photo[]
}

function toPins(photos: Photo[]): Pin[] {
  const byPlace = new Map<string, Pin>()
  for (const photo of photos) {
    const [lat, lon] = photo.exif?.place ?? []
    if (lat == null || lon == null) continue
    const key = `${lat},${lon}`
    const pin = byPlace.get(key)
    if (pin) pin.photos.push(photo)
    else byPlace.set(key, { key, lat, lon, photos: [photo] })
  }
  return [...byPlace.values()]
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Popup contents: the photos at this spot, each linking to its own page. */
function popupHtml(pin: Pin): string {
  const items = pin.photos
    .map((photo) => {
      const href = `/photos/${photo.id}`
      const date = formatPhotoDate(photo)
      return `<li><a href="${escapeHtml(href)}">
        <img src="${escapeHtml(imageUrl(photo.thumb ?? photo.src) ?? '')}" alt="${escapeHtml(photo.alt)}" loading="lazy" />
        <span>${escapeHtml(date)}</span>
      </a></li>`
    })
    .join('')
  return `<ul class="map-popup">${items}</ul>`
}

export function Component() {
  const { photos } = useLoaderData() as MapData
  const pins = useMemo(() => toPins(photos), [photos])
  const containerRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container || pins.length === 0) return
    let map: import('leaflet').Map | undefined
    let canceled = false

    import('leaflet')
      .then(({ default: L }) => {
        if (canceled || !containerRef.current) return
        map = L.map(container, { scrollWheelZoom: false })
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map)

        // circleMarker, not the default pin: drawn rather than an image, so it
        // sidesteps Leaflet's bundler-hostile icon URLs and takes the accent color.
        for (const pin of pins) {
          L.circleMarker([pin.lat, pin.lon], {
            radius: 7,
            weight: 2,
            color: '#ffffff',
            fillColor: '#b34a26',
            fillOpacity: 0.9,
          })
            .addTo(map)
            .bindPopup(popupHtml(pin), { minWidth: 140 })
        }

        map.fitBounds(
          pins.map((pin) => [pin.lat, pin.lon] as [number, number]),
          { padding: [40, 40], maxZoom: 12 },
        )
      })
      .catch(() => {
        if (!canceled) setFailed(true)
      })

    return () => {
      canceled = true
      map?.remove()
    }
  }, [pins])

  const description = 'A map of where Cailin Pitt has taken photographs.'

  return (
    <div className="photos photo-map">
      <Seo
        title="Photo map"
        description={description}
        path="/photos/map"
        jsonLd={pageSchema({
          path: '/photos/map',
          title: 'Photo map',
          description,
          type: 'CollectionPage',
        })}
      />
      <p className="tag-eyebrow">
        <Link to="/photos">← All photos</Link>
      </p>
      <h1>Photo map</h1>
      <p>
        {photos.length} photo{photos.length === 1 ? '' : 's'} across {pins.length} place
        {pins.length === 1 ? '' : 's'}. Positions are rounded to about a mile, so a pin
        marks a neighborhood rather than a spot.
      </p>

      {pins.length === 0 ? (
        <p className="photos-empty">
          No photos carry a location yet — only the ones whose originals recorded one do.
        </p>
      ) : failed ? (
        <p className="photos-empty">The map could not load. Try again later.</p>
      ) : (
        <div className="map-canvas" ref={containerRef} />
      )}
    </div>
  )
}
