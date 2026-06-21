import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { atprotoPublicationUri, posts } from '../lib/posts'
import { formatDate } from '../lib/posts'
import { personSchema, websiteSchema } from '../lib/structuredData'

export default function Home() {
  const recent = posts.slice(0, 5)
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
    </>
  )
}
