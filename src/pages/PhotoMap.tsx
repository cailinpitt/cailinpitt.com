import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData } from 'react-router-dom'
import 'leaflet/dist/leaflet.css'
import { Seo } from '../components/Seo'
import { imageUrl } from '../lib/images'
import { formatShotDate } from '../lib/exif'
import { pageSchema } from '../lib/structuredData'
import type { DatedPhoto } from '../lib/timeline'

// Where the photos were taken, from the coordinates images:sync reads off each
// original. Leaflet renders the map and OpenStreetMap serves the tiles — both
// free, no account and no key, which is why they're here rather than a
// commercial tile provider. Attribution below is required by the tile policy.
//
// Leaflet touches `window` the moment it's imported, so it can't be a top-level
// import on a prerendered page: the module is pulled in inside the effect, which
// only ever runs in a browser. The page's shell prerenders as normal and the map
// fills in after mount.

interface MapData {
  photos: DatedPhoto[]
}

export async function loader(): Promise<MapData | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    const { loadDatedPhotos } = await import('../lib/content.client')
    return { photos: loadDatedPhotos().filter((photo) => photo.place) }
  }
  const { loadDatedPhotos } = await import('../lib/content.server')
  return { photos: (await loadDatedPhotos()).filter((photo) => photo.place) }
}

/** Photos sharing a rounded coordinate, so overlapping pins become one marker. */
interface Pin {
  key: string
  lat: number
  lon: number
  photos: DatedPhoto[]
}

function toPins(photos: DatedPhoto[]): Pin[] {
  const byPlace = new Map<string, Pin>()
  for (const photo of photos) {
    const [lat, lon] = photo.place ?? []
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

/** Popup contents: the photos at this spot, each linking into the lightbox. */
function popupHtml(pin: Pin): string {
  const items = pin.photos
    .map((photo) => {
      const href = `${photo.galleryPath}?photo=${photo.index}`
      const date = formatShotDate(photo.date)
      return `<li><a href="${escapeHtml(href)}">
        <img src="${escapeHtml(imageUrl(photo.thumb ?? photo.src) ?? '')}" alt="${escapeHtml(photo.alt)}" loading="lazy" />
        <span>${escapeHtml(date ?? photo.galleryTitle)}</span>
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
    let cancelled = false

    import('leaflet')
      .then(({ default: L }) => {
        if (cancelled || !containerRef.current) return
        map = L.map(container, { scrollWheelZoom: false })
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map)

        // circleMarker rather than the default pin: it's drawn, not an image, so
        // it sidesteps Leaflet's bundler-hostile marker icon URLs entirely — and
        // it takes the site's accent colour.
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
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      map?.remove()
    }
  }, [pins])

  const description = 'A map of where Cailin Pitt has taken photographs.'

  return (
    <div className="gallery photo-map">
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
      <p className="lead">
        {photos.length} photo{photos.length === 1 ? '' : 's'} across {pins.length} place
        {pins.length === 1 ? '' : 's'}. Positions are rounded to about a kilometre, so a pin
        marks a neighbourhood rather than a spot.
      </p>

      {pins.length === 0 ? (
        <p className="gallery-empty">
          No photos carry a location yet — only galleries built from originals do.
        </p>
      ) : failed ? (
        <p className="gallery-empty">The map could not load. Try again later.</p>
      ) : (
        <div className="map-canvas" ref={containerRef} />
      )}
    </div>
  )
}
