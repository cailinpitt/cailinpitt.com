import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { posts, formatDate } from '../lib/posts'

export default function BlogIndex() {
  return (
    <>
      <Seo title="Blog" description="Writing by Cailin Pitt." path="/blog" />
      <h1>Blog</h1>
      <ul className="post-list">
        {posts.map((p) => (
          <li key={p.path}>
            <Link to={p.path}>{p.title}</Link>
            <time dateTime={p.date}>{formatDate(p.date)}</time>
          </li>
        ))}
      </ul>
    </>
  )
}
