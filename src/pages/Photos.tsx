import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import {
  FEED_TILE_SIZES,
  imageUrl,
  photoYearBreaks,
  thumbSrcset,
  type Photo,
  yearAnchor,
} from '../lib/photos'
import { pageSchema } from '../lib/structuredData'

// Every photograph in one square grid, newest first. No pagination or
// infinite scroll — all of them are in the prerendered html, and
// `loading="lazy"` means the browser only fetches what it needs. Keeps the
// page working without JS, keeps Cmd-F useful, and keeps year anchors real links.

// What a tile needs, and nothing else — the full manifest entry carries
// capture metadata only a photo's own page shows, and at 500 photos long,
// carrying that into loader data would double it for nothing.
type FeedPhoto = Pick<
  Photo,
  'id' | 'src' | 'thumb' | 'widths' | 'alt' | 'year' | 'width' | 'height' | 'tint'
>

const toTile = ({ id, src, thumb, widths, alt, year, width, height, tint }: Photo): FeedPhoto => ({
  id,
  src,
  thumb,
  widths,
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

// Year of the tiles at the top of the feed, for the floating marker — five
// hundred undated squares otherwise give no sense of where in fifteen years
// you are. Reuses the year-break anchors already in the DOM (#y2019). A
// scroll listener rather than an IntersectionObserver: the question is "which
// break is highest above the line" across all of them at once, not a single
// crossing event — and this also lands correctly on a cold load at
// /photos#y2019, where every crossing already happened before hydration.
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
      // Newest first, like the feed — the first break still below the line
      // ends the search.
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
  // Which tiles start a new year — carries the page's only anchors, so
  // /photos#y2019 still lands sensibly now that /2019 is gone.
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
          {/* currentColor like the other icons — an emoji pin brings its own
              red and fights the palette. */}
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

      {/* Fixed, not sticky, so it costs the prerendered page no space and
          shifts nothing on first scroll. aria-hidden since the years are
          reachable as real anchors from ⌘K. */}
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
              {/* Tile's own color under the image, so unloaded tiles read as
                  photos arriving rather than a grid of gray squares. Inline
                  since it's per-photo data, not a style. */}
              <Link to={`/photos/${photo.id}`} style={photo.tint ? { background: photo.tint } : undefined}>
<img
                  // Tile paints between ~117px and ~306px, so srcset picks from
                  // the grid renditions instead of always the 1000px one. `src`
                  // is the largest as fallback; full size is the photo's own page.
                  src={imageUrl(photo.thumb ?? photo.src)}
                  srcSet={thumbSrcset(photo)}
                  sizes={thumbSrcset(photo) ? FEED_TILE_SIZES : undefined}
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
