import { Link, useLoaderData } from 'react-router-dom'
import { posts as indexedPosts } from 'virtual:site-index'
import { Seo } from '../components/Seo'
import { IdentityLine } from '../components/IdentityLine'
import { NowPlayingBar } from '../components/NowPlayingBar'
import { ListeningSparkline } from '../components/ListeningExtras'
import { ReadingBar } from '../components/ReadingBar'
import { HomeTimeline } from '../components/HomeTimeline'
import { PhotoStrip } from '../components/PhotoStrip'
import { formatDate } from '../lib/posts'
import { toPreviews, type Photo, type PhotoPreview } from '../lib/photos'
import type { TimelinePhoto } from '../lib/timeline'
import type { Concert } from '../lib/concerts'
import { homeSchema } from '../lib/structuredData'

const RECENT_PHOTOS = 4
const RECENT_POSTS = 5
// Recent slices, enough to land a concert or a photo on one of the ~5 preview
// days — not the full history (that lives on /timeline).
const TIMELINE_CONCERTS = 8
const TIMELINE_PHOTOS = 25

// Just the fields the timeline preview reads — the manifest's exif etc. would be
// dead weight in the homepage's loader data.
const trimPhoto = (p: Photo): TimelinePhoto => ({
  id: p.id,
  date: p.date,
  src: p.src,
  thumb: p.thumb,
  alt: p.alt,
})

// Frontmatter only (title/date/path/tags), already bundled into every page via the command
// palette — reading it here means the homepage never has to load every post's full body.
type RecentPost = (typeof indexedPosts)[number]

interface HomeData {
  recent: RecentPost[]
  recentPhotos: PhotoPreview[]
  timelinePhotos: TimelinePhoto[]
  timelineConcerts: Concert[]
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
  const recent = indexedPosts.slice(0, RECENT_POSTS)
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    const { loadPhotos, loadDatedPhotos, loadPublicationUri, loadConcerts } = await import(
      '../lib/content.client'
    )
    return {
      recent,
      recentPhotos: toPreviews(loadPhotos(), RECENT_PHOTOS),
      timelinePhotos: loadDatedPhotos().slice(0, TIMELINE_PHOTOS).map(trimPhoto),
      timelineConcerts: loadConcerts().slice(0, TIMELINE_CONCERTS),
      publicationUri: loadPublicationUri(),
    }
  }
  const { loadPhotos, loadDatedPhotos, loadPublicationUri, loadConcerts } = await import(
    '../lib/content.server'
  )
  const [photos, datedPhotos, publicationUri, concerts] = await Promise.all([
    loadPhotos(),
    loadDatedPhotos(),
    loadPublicationUri(),
    loadConcerts(),
  ])
  return {
    recent,
    recentPhotos: toPreviews(photos, RECENT_PHOTOS),
    timelinePhotos: datedPhotos.slice(0, TIMELINE_PHOTOS).map(trimPhoto),
    timelineConcerts: concerts.slice(0, TIMELINE_CONCERTS),
    publicationUri,
  }
}

export function Component() {
  const { recent, recentPhotos, timelinePhotos, timelineConcerts, publicationUri } =
    useLoaderData() as HomeData
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

      <section className="now-strip" aria-labelledby="now-strip-heading">
        <h2 id="now-strip-heading" className="eyebrow">
          Right now
        </h2>
        <NowPlayingBar />
        <ReadingBar showLogLinks={false} showArticle={false} />
        <ListeningSparkline />
      </section>

      <HomeTimeline posts={indexedPosts} photos={timelinePhotos} concerts={timelineConcerts} />

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
