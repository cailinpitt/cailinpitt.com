import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { formatDate, type PostSummary } from '../lib/posts'
import { imageUrl } from '../lib/galleries'
import type { GallerySummary } from '../lib/content.server'
import { homeSchema } from '../lib/structuredData'

interface HomeData {
  recent: PostSummary[]
  recentGalleries: GallerySummary[]
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
    const { loadGallerySummaries, loadPostSummaries, loadPublicationUri } = await import(
      '../lib/content.client'
    )
    const posts = loadPostSummaries()
    const galleries = loadGallerySummaries()
    return {
      recent: posts.slice(0, 5),
      recentGalleries: galleries
        .filter((gallery) => !gallery.canonicalPath && gallery.cover)
        .slice(0, 4),
      publicationUri: loadPublicationUri(),
    }
  }
  const { loadGallerySummaries, loadPostSummaries, loadPublicationUri } = await import(
    '../lib/content.server'
  )
  const [posts, galleries, publicationUri] = await Promise.all([
    loadPostSummaries(),
    loadGallerySummaries(),
    loadPublicationUri(),
  ])
  return {
    recent: posts.slice(0, 5),
    recentGalleries: galleries
      .filter((gallery) => !gallery.canonicalPath && gallery.cover)
      .slice(0, 4),
    publicationUri,
  }
}

export function Component() {
  const { recent, recentGalleries, publicationUri } = useLoaderData() as HomeData
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
        <h1>Artist, software engineer, and occasional writer.</h1>
      </section>

      <section className="recent-projects" aria-labelledby="projects-heading">
        <h2 id="projects-heading" className="eyebrow">
          Current projects
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
            Recent writing
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

      {recentGalleries.length > 0 && (
        <section className="recent-photos" aria-labelledby="photos-heading">
          <h2 id="photos-heading" className="eyebrow">
            Recent photos
          </h2>
          <ul className="photo-previews">
            {recentGalleries.map((g) => (
              <li key={g.path}>
                <Link to={g.path} aria-label={`Photos — ${g.title}`}>
                  <img
                    src={imageUrl(g.cover?.src)}
                    alt=""
                    width={g.cover?.width}
                    height={g.cover?.height}
                    loading="lazy"
                    decoding="async"
                  />
                  <span className="photo-preview-label">{g.title}</span>
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
