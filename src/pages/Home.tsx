import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { posts } from '../lib/posts'
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
      />
      <section className="intro">
        <h1>Cailin Pitt</h1>
        <p>Photographer, hobbyist, and occasional writer.</p>
      </section>

      {recent.length > 0 && (
        <section className="recent-posts" aria-labelledby="recent-heading">
          <h2 id="recent-heading">Recent writing</h2>
          <ul className="post-list">
            {recent.map((p) => (
              <li key={p.path}>
                <Link to={p.path}>{p.title}</Link>
                <time dateTime={p.date}>{formatDate(p.date)}</time>
              </li>
            ))}
          </ul>
          <p>
            <Link to="/blog">All posts →</Link>
          </p>
        </section>
      )}
    </>
  )
}
