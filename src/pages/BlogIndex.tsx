import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { posts, formatDate } from '../lib/posts'

export default function BlogIndex() {
  return (
    <>
      <Seo title="Blog" description="Writing by Cailin Pitt." path="/blog" />
      <section className="post">
        <header className="post-header">
          <h1>Blog</h1>
        </header>
        <ul className="post-list">
          {posts.map((p) => (
            <li key={p.path}>
              <time dateTime={p.date}>{formatDate(p.date)}</time>
              <Link to={p.path}>{p.title}</Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
