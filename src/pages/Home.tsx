import { Link, useLoaderData } from 'react-router-dom'
import { posts as indexedPosts } from 'virtual:site-index'
import { Seo } from '../components/Seo'
import { IdentityLine } from '../components/IdentityLine'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { ListeningSparkline, OnThisDayLine } from '../components/ListeningExtras'
import { ReadingBar } from '../components/ReadingBar'
import { WatchingBar } from '../components/WatchingBar'
import { ConcertBar } from '../components/ConcertBar'
import { MovingBar } from '../components/MovingBar'
import { NotesBar } from '../components/NotesBar'
import { PhotoStrip } from '../components/PhotoStrip'
import { formatDate } from '../lib/posts'
import { toPreviews, type PhotoPreview } from '../lib/photos'
import type { Concert } from '../lib/concerts'
import { homeSchema } from '../lib/structuredData'

const RECENT_PHOTOS = 4
const RECENT_POSTS = 5

// Frontmatter only (title/date/path/tags), already bundled into every page via the command
// palette — reading it here means the homepage never has to load every post's full body just
// to show links to the newest 5.
type RecentPost = (typeof indexedPosts)[number]

interface HomeData {
  recent: RecentPost[]
  recentPhotos: PhotoPreview[]
  publicationUri: string | null
  lastConcert: Concert | null
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
  const recent = indexedPosts.slice(0, RECENT_POSTS)
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    const { loadPhotos, loadPublicationUri, loadConcerts } = await import('../lib/content.client')
    return {
      recent,
      recentPhotos: toPreviews(loadPhotos(), RECENT_PHOTOS),
      publicationUri: loadPublicationUri(),
      lastConcert: loadConcerts()[0] ?? null,
    }
  }
  const { loadPhotos, loadPublicationUri, loadConcerts } = await import('../lib/content.server')
  const [photos, publicationUri, concerts] = await Promise.all([
    loadPhotos(),
    loadPublicationUri(),
    loadConcerts(),
  ])
  return {
    recent,
    recentPhotos: toPreviews(photos, RECENT_PHOTOS),
    publicationUri,
    lastConcert: concerts[0] ?? null,
  }
}

export function Component() {
  const { recent, recentPhotos, publicationUri, lastConcert } = useLoaderData() as HomeData
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

        <h2 className="eyebrow">💬 Latest note</h2>
        <NotesBar />
        <p className="more">
          <Link to="/notes">All notes →</Link>
        </p>

        <h2 className="eyebrow">📖 Reading</h2>
        <ReadingBar />

        <h2 className="eyebrow">🎬 Watching</h2>
        <WatchingBar />
        <p className="more">
          <Link to="/watching">Watching log →</Link>
        </p>

        {lastConcert && (
          <>
            <h2 className="eyebrow">🎤 Concerts</h2>
            <ConcertBar concert={lastConcert} />
            <p className="more">
              <Link to="/concerts">Concert log →</Link>
            </p>
          </>
        )}

        <h2 className="eyebrow">🚲 Moving</h2>
        <MovingBar />
        <p className="more">
          <Link to="/moving">Moving log →</Link>
        </p>
      </section>

      {recent.length > 0 && (
        <section className="home-section recent" aria-labelledby="recent-heading">
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

      <section className="home-section recent-projects" aria-labelledby="projects-heading">
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

      {recentPhotos.length > 0 && (
        <section className="home-section recent-photos" aria-labelledby="photos-heading">
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
