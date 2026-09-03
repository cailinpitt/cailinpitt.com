import { Link, useLoaderData } from 'react-router-dom'
import { posts as indexedPosts } from 'virtual:site-index'
import { Seo } from '../components/Seo'
import { IdentityLine } from '../components/IdentityLine'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { ListeningSparkline, OnThisDayLine } from '../components/ListeningExtras'
import { ReadingBar } from '../components/ReadingBar'
import { WritingBar } from '../components/WritingBar'
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

const PANEL_ICON = {
  music: ['M9 18V5l12-2v13', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  note: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  book: ['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'],
  film: [
    'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
    'M7 3v18',
    'M17 3v18',
    'M3 12h18',
    'M3 7.5h4',
    'M3 16.5h4',
    'M17 7.5h4',
    'M17 16.5h4',
  ],
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  bike: [
    'M5.5 17.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M18.5 17.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    'M12 17.5V14l-3-3 4-3 2 3h2',
  ],
  pen: ['M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z', 'm15 5 4 4'],
} as const

function PanelIcon({ paths }: { paths: readonly string[] }) {
  return (
    <svg
      className="panel-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

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
      </section>

      <section className="lately" aria-labelledby="lately-heading">
        <h2 id="lately-heading" className="section-title">
          Lately
        </h2>
        <div className="panel-grid">
          <div className="panel panel-wide">
            <h3 className="panel-head">
              <PanelIcon paths={PANEL_ICON.music} /> Last played
            </h3>
            <NowPlayingBar />
            <ListeningSparkline />
            <OnThisDayLine />
            <p className="more">
              <Link to="/listening">Listening log →</Link>
            </p>
          </div>

          <div className="panel">
            <h3 className="panel-head">
              <PanelIcon paths={PANEL_ICON.pen} /> Latest post
            </h3>
            <WritingBar post={recent[0] ?? null} />
            <p className="more">
              <Link to="/blog">All posts →</Link>
            </p>
          </div>

          <div className="panel">
            <h3 className="panel-head">
              <PanelIcon paths={PANEL_ICON.note} /> Latest note
            </h3>
            <NotesBar />
            <p className="more">
              <Link to="/notes">All notes →</Link>
            </p>
          </div>

          <div className="panel">
            <h3 className="panel-head">
              <PanelIcon paths={PANEL_ICON.book} /> Reading
            </h3>
            <ReadingBar showLogLinks={false} showArticle={false} />
            <p className="more">
              <Link to="/reading">Book log →</Link>
              {' · '}
              <Link to="/reading/articles">Article log →</Link>
            </p>
          </div>

          <div className="panel">
            <h3 className="panel-head">
              <PanelIcon paths={PANEL_ICON.film} /> Watching
            </h3>
            <WatchingBar />
            <p className="more">
              <Link to="/watching">Watching log →</Link>
            </p>
          </div>

          <div className="panel">
            <h3 className="panel-head">
              <PanelIcon paths={PANEL_ICON.mic} /> Concerts
            </h3>
            <ConcertBar concert={lastConcert} />
            <p className="more">
              <Link to="/concerts">Concert log →</Link>
            </p>
          </div>

          <div className="panel">
            <h3 className="panel-head">
              <PanelIcon paths={PANEL_ICON.bike} /> Moving
            </h3>
            <MovingBar />
            <p className="more">
              <Link to="/moving">Moving log →</Link>
            </p>
          </div>
        </div>
      </section>

      {recent.length > 0 && (
        <section className="home-section recent" aria-labelledby="recent-heading">
          <h2 id="recent-heading" className="section-title">
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

      <section className="home-section recent-projects" aria-labelledby="projects-heading">
        <h2 id="projects-heading" className="section-title">
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

      {recentPhotos.length > 0 && (
        <section className="home-section recent-photos" aria-labelledby="photos-heading">
          <h2 id="photos-heading" className="section-title">
            Recent photos
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
