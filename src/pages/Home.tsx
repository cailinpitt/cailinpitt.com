import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { IdentityLine } from '../components/IdentityLine'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { ListeningSparkline, OnThisDayLine } from '../components/ListeningExtras'
import { ReadingBar } from '../components/ReadingBar'
import { formatDate, type PostSummary } from '../lib/posts'
import { imageUrl } from '../lib/galleries'
import { formatShotDateShort } from '../lib/exif'
import type { GallerySummary } from '../lib/content.server'
import type { DatedPhoto } from '../lib/timeline'
import { homeSchema } from '../lib/structuredData'

/** A thumbnail in the "Recent photos" strip, from either source below. */
interface PhotoPreview {
  href: string
  src: string
  /** Capture date for a real photo, gallery title for a cover fallback. */
  label: string
}

/**
 * The four most recent photographs. This used to be the four newest *galleries*
 * showing their cover image, which meant a heading that said "Recent photos" over
 * a cover from 2020 that only changed when a whole gallery was added. Capture
 * dates make the real thing possible, and each thumbnail can link straight to
 * that frame in the lightbox.
 *
 * Galleries with no capture dates (everything pre-2026, which arrived from
 * Squarespace EXIF-stripped) still fall back to covers, so the section can't
 * vanish on a repo whose photos carry no metadata.
 */
function toPreviews(photos: DatedPhoto[], galleries: GallerySummary[]): PhotoPreview[] {
  if (photos.length) {
    return photos.slice(0, 4).map((photo) => ({
      href: `${photo.galleryPath}?photo=${photo.index}`,
      src: photo.thumb ?? photo.src,
      label: formatShotDateShort(photo.date) ?? photo.galleryTitle,
    }))
  }
  return galleries
    .filter((gallery) => !gallery.canonicalPath && gallery.cover)
    .slice(0, 4)
    .map((gallery) => ({
      href: gallery.path,
      src: gallery.cover?.thumb ?? gallery.cover?.src ?? '',
      label: gallery.title,
    }))
}

interface HomeData {
  recent: PostSummary[]
  recentPhotos: PhotoPreview[]
  publicationUri: string | null
}

const featuredProjects = [
  {
    name: 'Chicago Transit Alerts',
    description: 'CTA and Metra alerts, independently detected disruptions, and reliability history.',
    href: 'https://chicagotransitalerts.app/',
  },
  {
    name: 'Atlanta Transit Alerts',
    description: 'MARTA service alerts and bot-observed disruptions across rail, streetcar, and bus service.',
    href: 'https://atlantatransitalerts.app/',
  },
  {
    name: 'CTA Bus Bingo',
    description: 'A trip planner for chaining together Chicago bus routes you have not ridden.',
    href: 'https://cailinpitt.github.io/cta-bus-bingo/',
  },
]

export async function loader(): Promise<HomeData | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    const { loadDatedPhotos, loadGallerySummaries, loadPostSummaries, loadPublicationUri } =
      await import('../lib/content.client')
    return {
      recent: loadPostSummaries().slice(0, 5),
      recentPhotos: toPreviews(loadDatedPhotos(), loadGallerySummaries()),
      publicationUri: loadPublicationUri(),
    }
  }
  const { loadDatedPhotos, loadGallerySummaries, loadPostSummaries, loadPublicationUri } =
    await import('../lib/content.server')
  const [posts, photos, galleries, publicationUri] = await Promise.all([
    loadPostSummaries(),
    loadDatedPhotos(),
    loadGallerySummaries(),
    loadPublicationUri(),
  ])
  return {
    recent: posts.slice(0, 5),
    recentPhotos: toPreviews(photos, galleries),
    publicationUri,
  }
}

export function Component() {
  const { recent, recentPhotos, publicationUri } = useLoaderData() as HomeData
  return (
    <>
      <Seo
        title="Cailin Pitt"
        description="Photography, software projects, and writing by Cailin Pitt."
        path="/"
        jsonLd={homeSchema()}
        publicationUri={publicationUri}
      />
      <section className="intro">
        <IdentityLine />
        <h2 className="eyebrow">🎧 Last played</h2>
        <NowPlayingBar />
        <ListeningSparkline />
        <OnThisDayLine />
        <p className="more">
          <Link to="/listening">Listening log →</Link>
        </p>

        <h2 className="eyebrow">📖 Reading</h2>
        <ReadingBar />
        <p className="more">
          <Link to="/reading">Reading log →</Link>
        </p>
      </section>

      <section className="recent-projects" aria-labelledby="projects-heading">
        <h2 id="projects-heading" className="eyebrow">
          🧑‍💻 Current projects
        </h2>
        <ul className="project-previews">
          {featuredProjects.map((project) => (
            <li key={project.name}>
              <h3>
                <a href={project.href}>{project.name}</a>
              </h3>
              <p>{project.description}</p>
            </li>
          ))}
        </ul>
        <p className="more">
          <Link to="/projects">All projects →</Link>
        </p>
      </section>

      {recent.length > 0 && (
        <section className="recent" aria-labelledby="recent-heading">
          <h2 id="recent-heading" className="eyebrow">
            ✍️ Recent writing
          </h2>
          <ul className="post-list">
            {recent.map((p) => (
              <li key={p.path}>
                <time dateTime={p.date}>{formatDate(p.date)}</time>
                <Link to={p.path}>{p.title}</Link>
              </li>
            ))}
          </ul>
          <p className="more">
            <Link to="/blog">All posts →</Link>
          </p>
        </section>
      )}

      {recentPhotos.length > 0 && (
        <section className="recent-photos" aria-labelledby="photos-heading">
          <h2 id="photos-heading" className="eyebrow">
            📸 Recent photos
          </h2>
          <ul className="photo-previews">
            {recentPhotos.map((photo) => (
              <li key={photo.href}>
                <Link to={photo.href} aria-label={`Photo — ${photo.label}`}>
                  <img src={imageUrl(photo.src)} alt="" loading="lazy" decoding="async" />
                  <span className="photo-preview-label">{photo.label}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="more">
            <Link to="/photos">All photos →</Link>
          </p>
        </section>
      )}
    </>
  )
}
