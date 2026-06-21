import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { atprotoPublicationUri, posts } from '../lib/posts'
import { formatDate } from '../lib/posts'
import { galleries, imageUrl } from '../lib/galleries'
import { personSchema, websiteSchema } from '../lib/structuredData'

export default function Home() {
  const recent = posts.slice(0, 5)
  // Newest galleries with photos, excluding alias galleries (e.g. /past-work → /2022).
  const recentGalleries = galleries.filter((g) => !g.canonicalPath && g.images.length > 0).slice(0, 4)
  return (
    <>
      <Seo
        title="Cailin Pitt"
        description="Photography and writing by Cailin Pitt."
        path="/"
        jsonLd={[websiteSchema(), personSchema()]}
        publicationUri={atprotoPublicationUri}
      />
      <section className="intro">
        <h1>Artist, software engineer, and occasional writer.</h1>
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
                    src={imageUrl(g.images[0].src)}
                    alt=""
                    width={g.images[0].width}
                    height={g.images[0].height}
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
