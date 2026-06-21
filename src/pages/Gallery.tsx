import { Seo } from '../components/Seo'
import type { Gallery as GalleryData } from '../lib/galleries'

export default function Gallery({ gallery }: { gallery: GalleryData }) {
  return (
    <>
      <Seo
        title={gallery.title}
        description={gallery.description ?? `Photography — ${gallery.title}.`}
        path={gallery.path}
        image={gallery.images[0]?.src}
      />
      <h1>{gallery.title}</h1>
      {gallery.images.length === 0 ? (
        <p className="gallery-empty">Photos coming soon.</p>
      ) : (
        <div className="gallery-grid">
          {gallery.images.map((img) => (
            <figure key={img.src}>
              <img
                src={img.src}
                alt={img.alt}
                width={img.width}
                height={img.height}
                loading="lazy"
                decoding="async"
              />
            </figure>
          ))}
        </div>
      )}
    </>
  )
}
