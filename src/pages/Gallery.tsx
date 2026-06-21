import { useRef, useState } from 'react'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { imageUrl, type Gallery as GalleryData, type GalleryImage } from '../lib/galleries'
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

export function Component() {
  const gallery = useLoaderData() as GalleryData
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [active, setActive] = useState<GalleryImage | null>(null)

  function open(img: GalleryImage) {
    setActive(img)
    dialogRef.current?.showModal()
  }
  function close() {
    dialogRef.current?.close()
  }

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

      {gallery.images.length === 0 ? (
        <p className="gallery-empty">Photos coming soon.</p>
      ) : (
        <div className="gallery-grid">
          {gallery.images.map((img) => (
            <figure key={img.src}>
              <button
                type="button"
                onClick={() => open(img)}
                aria-label={`Enlarge${img.alt ? `: ${img.alt}` : ''}`}
              >
                <img
                  src={imageUrl(img.src)}
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
        onClose={() => setActive(null)}
        onClick={(e) => {
          // Click on the backdrop (the dialog element itself) closes it.
          if (e.target === dialogRef.current) close()
        }}
      >
        <button type="button" className="lightbox-close" onClick={close} aria-label="Close">
          ×
        </button>
        {active && (
          <figure style={{ margin: 0 }}>
            <img src={imageUrl(active.src)} alt={active.alt} />
            {active.alt && <figcaption>{active.alt}</figcaption>}
          </figure>
        )}
      </dialog>
    </div>
  )
}
