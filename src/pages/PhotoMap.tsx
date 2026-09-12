import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData, useSearchParams } from 'react-router-dom'
import 'leaflet/dist/leaflet.css'
import { resolvedTheme, THEME_EVENT } from '../components/ThemeToggle'
import { Seo } from '../components/Seo'
import { byNewest, formatPhotoDate, imageUrl, type Photo } from '../lib/photos'
import { pageSchema } from '../lib/structuredData'

// CARTO's light/dark basemaps read as an extension of the site's own warm-paper
// palette; the default OSM tiles are stark white and needed a CSS invert hack
// to survive dark mode at all. CARTO now meters this endpoint by API key (free,
// 5M requests/month) — see VITE_CARTO_API_KEY in .env.example.
const CARTO_KEY = import.meta.env.VITE_CARTO_API_KEY as string | undefined
const CARTO_TILES = {
  light: `https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=${CARTO_KEY}`,
  dark: `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${CARTO_KEY}`,
} as const
const CARTO_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

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
  const heading =
    pin.photos.length > 1 ? `<p class="map-popup-count">${pin.photos.length} photos here</p>` : ''
  return `${heading}<ul class="map-popup">${items}</ul>`
}

/** All pins, framed together — the default view and the "view all" reset. */
function showAllBounds(pins: Pin[]): [number, number][] {
  return pins.map((pin) => [pin.lat, pin.lon])
}

/** Bigger circles at places with more photos, so density reads at a glance. */
function pinRadius(pin: Pin): number {
  return Math.min(7 + Math.max(pin.photos.length - 1, 0) * 1.5, 14)
}

export function Component() {
  const { photos } = useLoaderData() as MapData
  const pins = useMemo(() => toPins(photos), [photos])
  // Most-recently-photographed place first — same reverse-chronological read
  // as the rest of the site, and each pin's own photos are already newest
  // first (they're built from the already-sorted feed), so `photos[0]` is it.
  const places = useMemo(() => [...pins].sort((a, b) => byNewest(a.photos[0], b.photos[0])), [pins])
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<import('leaflet').Map | undefined>(undefined)
  const markersRef = useRef(new Map<string, import('leaflet').CircleMarker>())
  const [failed, setFailed] = useState(false)
  const [searchParams] = useSearchParams()

  // Arriving from a photo's own page via its coordinates link: center on that
  // photo's pin instead of the usual all-photos overview, so there's nothing
  // to refind.
  const focusPhotoId = searchParams.get('photo')
  const focusPin = focusPhotoId
    ? pins.find((pin) => pin.photos.some((photo) => photo.id === focusPhotoId))
    : undefined

  const showAll = () => {
    const map = mapRef.current
    if (!map || pins.length === 0) return
    map.fitBounds(showAllBounds(pins), { padding: [40, 40], maxZoom: 12 })
  }

  /** Jump the map to one place from the "Places" grid below it. */
  const flyTo = (pin: Pin) => {
    const map = mapRef.current
    if (!map) return
    map.setView([pin.lat, pin.lon], Math.max(map.getZoom(), 14))
    markersRef.current.get(pin.key)?.openPopup()
    containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container || pins.length === 0) return
    let map: import('leaflet').Map | undefined
    let media: MediaQueryList | undefined
    let onThemeChange: (() => void) | undefined
    let canceled = false

    import('leaflet')
      .then(({ default: L }) => {
        if (canceled || !containerRef.current) return
        // Scroll-to-zoom starts off so scrolling the page past the map doesn't
        // get trapped by it; a click on the map unlocks it, same as most
        // embedded-map widgets.
        map = L.map(container, { scrollWheelZoom: false })
        mapRef.current = map

        const tiles = L.tileLayer(CARTO_TILES[resolvedTheme()], {
          maxZoom: 19,
          attribution: CARTO_ATTRIBUTION,
        }).addTo(map)

        // Swap the basemap in place on a theme change — no CSS filter, no remount.
        onThemeChange = () => tiles.setUrl(CARTO_TILES[resolvedTheme()])
        media = window.matchMedia('(prefers-color-scheme: dark)')
        media.addEventListener('change', onThemeChange)
        window.addEventListener(THEME_EVENT, onThemeChange)

        // circleMarker, not the default pin: drawn rather than an image, so it
        // sidesteps Leaflet's bundler-hostile icon URLs and takes the accent color.
        const markers = markersRef.current
        markers.clear()
        for (const pin of pins) {
          const marker = L.circleMarker([pin.lat, pin.lon], {
            radius: pinRadius(pin),
            weight: 2,
            color: '#ffffff',
            fillColor: '#b34a26',
            fillOpacity: 0.9,
          })
            .addTo(map)
            .bindPopup(popupHtml(pin), { minWidth: 160 })
          markers.set(pin.key, marker)
        }

        if (focusPin) {
          map.setView([focusPin.lat, focusPin.lon], 14)
          markers.get(focusPin.key)?.openPopup()
        } else {
          map.fitBounds(showAllBounds(pins), { padding: [40, 40], maxZoom: 12 })
        }

        map.once('click', () => map?.scrollWheelZoom.enable())
      })
      .catch(() => {
        if (!canceled) setFailed(true)
      })

    return () => {
      canceled = true
      if (onThemeChange) {
        window.removeEventListener(THEME_EVENT, onThemeChange)
        media?.removeEventListener('change', onThemeChange)
      }
      map?.remove()
      mapRef.current = undefined
      markersRef.current.clear()
    }
  }, [pins, focusPin])

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
        <>
          {focusPin && (
            <p className="map-focus-note">
              Showing where this photo was taken.{' '}
              <button type="button" onClick={showAll}>
                View all photos on the map
              </button>
            </p>
          )}
          <div className="map-canvas" ref={containerRef} />
          <p className="map-hint">Click the map to enable scroll-to-zoom.</p>

          {places.length > 1 && (
            <>
              <h2>Places</h2>
              <ul className="map-places">
                {places.map((pin) => {
                  const cover = pin.photos[0]
                  const count = pin.photos.length
                  return (
                    <li key={pin.key}>
                      <button
                        type="button"
                        onClick={() => flyTo(pin)}
                        aria-label={`Show ${count} photo${count === 1 ? '' : 's'} near ${pin.lat.toFixed(2)}, ${pin.lon.toFixed(2)} on the map`}
                        style={cover.tint ? { background: cover.tint } : undefined}
                      >
                        <img
                          src={imageUrl(cover.thumb ?? cover.src)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                        <span className="map-place-label">
                          <span>{formatPhotoDate(cover)}</span>
                          {count > 1 && <span className="map-place-count">{count}</span>}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
