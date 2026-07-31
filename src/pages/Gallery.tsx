import { useCallback, useEffect, useRef, useState } from 'react'
import { useLoaderData, useSearchParams, type LoaderFunctionArgs } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { imageUrl, type Gallery as GalleryData } from '../lib/galleries'
import { formatCapture, formatSettings } from '../lib/exif'
import { pageSchema } from '../lib/structuredData'

export async function loader({ request }: LoaderFunctionArgs): Promise<GalleryData | null> {
  if (!import.meta.env.SSR && !import.meta.env.DEV) return null
  const { loadGalleries } = import.meta.env.SSR
    ? await import('../lib/content.server')
    : await import('../lib/content.client')
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/'
  const gallery = (await loadGalleries()).find((item) => item.path === path)
  if (!gallery) throw new Response('Not found', { status: 404 })
  return gallery
}

// Opening the lightbox is a `?photo=` change on this same route, which React
// Router would otherwise treat as a reason to re-run the loader on every arrow
// press. The gallery doesn't depend on the query string, so pin the data.
export const shouldRevalidate = () => false

export function Component() {
  const gallery = useLoaderData() as GalleryData
  const dialogRef = useRef<HTMLDialogElement>(null)
  const count = gallery.images.length

  // Which photo is open lives in the url (?photo=12, 1-based) so a single frame
  // is linkable and back/forward behave. Every update replaces rather than
  // pushes: paging through 140 photos shouldn't bury the previous page under
  // 140 history entries.
  const [params, setParams] = useSearchParams()

  // The prerendered html never has a query string, so reading it during the
  // first client render would mismatch hydration. Resolve it after mount
  // instead — same approach as ThemeToggle and IdentityLine.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const raw = mounted ? Number(params.get('photo')) : NaN
  const index = Number.isInteger(raw) && raw >= 1 && raw <= count ? raw - 1 : null
  const active = index != null ? gallery.images[index] : null
  const capture = formatCapture(active?.exif)
  const settings = formatSettings(active?.exif)

  const show = useCallback(
    (next: number | null) => {
      const updated = new URLSearchParams(params)
      if (next == null) updated.delete('photo')
      else updated.set('photo', String(next + 1))
      setParams(updated, { replace: true })
    },
    [params, setParams],
  )

  // Wraps at both ends, so holding an arrow key through a gallery never dead-ends.
  const step = useCallback(
    (delta: number) => {
      if (index == null || count === 0) return
      show((index + delta + count) % count)
    },
    [count, index, show],
  )

  // Drive the native <dialog> from the url rather than the other way around, so
  // a pasted ?photo= link opens the lightbox on load.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (index != null && !dialog.open) dialog.showModal()
    else if (index == null && dialog.open) dialog.close()
  }, [index])

  // Warm the neighbours: the full-size renditions are up to 2560px, and without
  // this every arrow press starts from a blank frame.
  useEffect(() => {
    if (index == null || count < 2) return
    for (const delta of [1, -1]) {
      const url = imageUrl(gallery.images[(index + delta + count) % count]?.src)
      if (url) new Image().src = url
    }
  }, [count, gallery.images, index])

  return (
    <div className="gallery">
      <Seo
        title={gallery.title}
        description={gallery.description ?? `Photography — ${gallery.title}.`}
        path={gallery.canonicalPath ?? gallery.path}
        image={gallery.images[0] ? imageUrl(gallery.images[0].src) : undefined}
        jsonLd={pageSchema({
          path: gallery.canonicalPath ?? gallery.path,
          title: gallery.title,
          description: gallery.description ?? `Photography — ${gallery.title}.`,
          image: gallery.images[0]?.src,
          type: 'ImageGallery',
        })}
      />
      <h1>{gallery.title}</h1>

      {count === 0 ? (
        <p className="gallery-empty">Photos coming soon.</p>
      ) : (
        <div className="gallery-grid">
          {gallery.images.map((img, i) => (
            <figure key={img.src}>
              <button
                type="button"
                onClick={() => show(i)}
                aria-label={`Enlarge photo ${i + 1} of ${count}${img.alt ? `: ${img.alt}` : ''}`}
              >
                <img
                  // The grid cell is ~280–400px wide, so the small rendition is what
                  // should load here; the full size is only for the lightbox.
                  src={imageUrl(img.thumb ?? img.src)}
                  srcSet={
                    img.thumb && img.width
                      ? `${imageUrl(img.thumb)} 1000w, ${imageUrl(img.src)} ${img.width}w`
                      : undefined
                  }
                  sizes="(max-width: 700px) 92vw, 400px"
                  alt={img.alt}
                  width={img.width}
                  height={img.height}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            </figure>
          ))}
        </div>
      )}

      <dialog
        ref={dialogRef}
        className="lightbox"
        aria-label={`${gallery.title} — photo viewer`}
        onClose={() => show(null)}
        onKeyDown={(e) => {
          // Escape is handled natively by <dialog>; only paging needs wiring.
          if (e.key === 'ArrowRight') {
            e.preventDefault()
            step(1)
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            step(-1)
          }
        }}
        onClick={(e) => {
          // Click on the backdrop (the dialog element itself) closes it.
          if (e.target === dialogRef.current) show(null)
        }}
      >
        <button type="button" className="lightbox-close" onClick={() => show(null)} aria-label="Close">
          ×
        </button>

        {count > 1 && (
          <>
            <button
              type="button"
              className="lightbox-nav is-prev"
              onClick={() => step(-1)}
              aria-label="Previous photo"
            >
              ‹
            </button>
            <button
              type="button"
              className="lightbox-nav is-next"
              onClick={() => step(1)}
              aria-label="Next photo"
            >
              ›
            </button>
          </>
        )}

        {active && index != null && (
          <figure className="lightbox-figure">
            <img src={imageUrl(active.src)} alt={active.alt} />
            <figcaption>
              {active.alt && <span className="lightbox-alt">{active.alt}</span>}
              {/* Only the galleries built from originals/ carry capture data;
                  the rest fall through to just the counter. */}
              {capture && <span className="lightbox-capture">{capture}</span>}
              {settings && <span className="lightbox-settings">{settings}</span>}
              <span className="lightbox-counter">
                {index + 1} / {count}
              </span>
            </figcaption>
          </figure>
        )}
      </dialog>
    </div>
  )
}
