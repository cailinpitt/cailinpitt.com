import { Link, useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { IdentityLine } from '../components/IdentityLine'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { ListeningSparkline, OnThisDayLine } from '../components/ListeningExtras'
import { ReadingBar } from '../components/ReadingBar'
import { WatchingBar } from '../components/WatchingBar'
import { MovingBar } from '../components/MovingBar'
import { NotesBar } from '../components/NotesBar'
import { PhotoStrip } from '../components/PhotoStrip'
import { formatDate, type PostSummary } from '../lib/posts'
import { toPreviews, type PhotoPreview } from '../lib/photos'
import { homeSchema } from '../lib/structuredData'

/** How many photographs the strip shows. */
const RECENT_PHOTOS = 4

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
    const { loadPhotos, loadPostSummaries, loadPublicationUri } =
      await import('../lib/content.client')
    return {
      recent: loadPostSummaries().slice(0, 5),
      recentPhotos: toPreviews(loadPhotos(), RECENT_PHOTOS),
      publicationUri: loadPublicationUri(),
    }
  }
  const { loadPhotos, loadPostSummaries, loadPublicationUri } =
    await import('../lib/content.server')
  const [posts, photos, publicationUri] = await Promise.all([
    loadPostSummaries(),
    loadPhotos(),
    loadPublicationUri(),
  ])
  return {
    recent: posts.slice(0, 5),
    recentPhotos: toPreviews(photos, RECENT_PHOTOS),
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
        <p className="intro-now">
          <Link to="/now">What I'm doing now →</Link>
        </p>
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

        <h2 className="eyebrow">🎬 Watching</h2>
        <WatchingBar />
        <p className="more">
          <Link to="/watching">Watching log →</Link>
        </p>

        <h2 className="eyebrow">🚲 Moving</h2>
        <MovingBar />
        <p className="more">
          <Link to="/moving">Moving log →</Link>
        </p>
      </section>

      <section className="recent-notes" aria-labelledby="notes-heading">
        <h2 id="notes-heading" className="eyebrow">
          💬 Latest note
        </h2>
        <NotesBar />
        <p className="more">
          <Link to="/notes">All notes →</Link>
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
          <PhotoStrip photos={recentPhotos} />
          <p className="more">
            <Link to="/photos">All photos →</Link>
          </p>
        </section>
      )}
    </>
  )
}
