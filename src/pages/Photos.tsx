import { useEffect, useMemo, useState } from 'react'
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
type FeedPhoto = Pick<Photo, 'id' | 'src' | 'thumb' | 'alt' | 'year' | 'width' | 'height' | 'tint'>

const toTile = ({ id, src, thumb, alt, year, width, height, tint }: Photo): FeedPhoto => ({
  id,
  src,
  thumb,
  alt,
  year,
  width,
  height,
  tint,
})

export async function loader(): Promise<FeedPhoto[] | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    return (await import('../lib/content.client')).loadPhotos().map(toTile)
  }
  const { loadPhotos } = await import('../lib/content.server')
  return (await loadPhotos()).map(toTile)
}

/** How far below the top of the viewport a tile counts as "what you're looking at". */
const YEAR_LINE = 96

/**
 * The year of the tiles currently at the top of the feed, for the marker that
 * floats over it while scrolling.
 *
 * Five hundred undated squares give a reader no idea where in fifteen years of
 * photographs they are. The year-break tiles already carry anchors (`#y2019`),
 * so this needs no new markup — it measures those and reports the last one to
 * have passed the line.
 *
 * A scroll listener rather than an IntersectionObserver: the question is "which
 * break is highest above the line", which is a comparison across all of them at
 * one instant, not an event about one crossing. There are ~13 breaks, so a
 * measurement is cheap, and doing it in a rAF means at most one per frame. It
 * also lands correctly on a cold load at `/photos#y2019`, where every crossing
 * happened before there was anything listening.
 */
function useFeedYear(years: string[]): string | null {
  const [year, setYear] = useState<string | null>(null)

  useEffect(() => {
    // Resolved once: the break tiles are in the prerendered HTML and don't move.
    const marks = years
      .map((value) => ({ year: value, el: document.getElementById(yearAnchor(value)) }))
      .filter((mark): mark is { year: string; el: HTMLElement } => mark.el !== null)
    if (!marks.length) return

    let frame = 0
    const measure = () => {
      frame = 0
      let current: string | null = null
      // Newest first, like the feed, so the first break still below the line
      // ends the search — everything after it is further down the page.
      for (const mark of marks) {
        if (mark.el.getBoundingClientRect().top > YEAR_LINE) break
        current = mark.year
      }
      setYear(current)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [years])

  return year
}

export function Component() {
  const photos = useLoaderData() as FeedPhoto[]
  const count = photos.length
  // Which tiles start a new year. They carry the only anchors on the page, so
  // /photos#y2019 still lands somewhere sensible now that /2019 is gone.
  const breaks = useMemo(() => photoYearBreaks(photos), [photos])
  // Stable across renders, so the effect that measures them doesn't re-bind.
  const years = useMemo(
    () => photos.filter((photo) => breaks.has(photo.id)).map((photo) => photo.year),
    [photos, breaks],
  )
  const feedYear = useFeedYear(years)
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

      {/* Fixed rather than sticky, so it costs the prerendered page no space and
          appearing on first scroll shifts nothing. aria-hidden because it is a
          scroll affordance that changes constantly — the years are reachable as
          real anchors from ⌘K, which is what a screen reader should use. */}
      {feedYear && (
        <p className="photo-year-marker" aria-hidden="true">
          {feedYear}
        </p>
      )}

      {count === 0 ? (
        <p className="photos-empty">Photos coming soon.</p>
      ) : (
        <ul className="photo-feed">
          {photos.map((photo) => (
            <li key={photo.id} id={breaks.has(photo.id) ? yearAnchor(photo.year) : undefined}>
              {/* The tile's own color under the image, so a screen of tiles that
                  haven't loaded reads as the photographs arriving rather than as
                  a grid of identical gray squares. Inline because it is per-photo
                  data, not a style. */}
              <Link to={`/photos/${photo.id}`} style={photo.tint ? { background: photo.tint } : undefined}>
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
