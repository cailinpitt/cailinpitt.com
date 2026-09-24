import { Link } from 'react-router-dom'
import type { PostLinks } from '../lib/postLinks'
import { postYear, type PostSummary } from '../lib/posts'

function Branch({ label, posts, dir }: { label: string; posts: PostSummary[]; dir: 'in' | 'out' }) {
  return (
    <>
      <p className={`link-graph-label${dir === 'out' ? ' link-graph-row' : ''}`}>{label}</p>
      <ul className={`link-graph-${dir}`}>
        {posts.map((p) => (
          <li key={p.path} className="link-graph-row">
            <span className="link-graph-node" aria-hidden="true" />
            <Link to={p.path}>{p.title}</Link>
            <time dateTime={p.date}>{postYear(p.date)}</time>
          </li>
        ))}
      </ul>
    </>
  )
}

// A vertical trunk through this post: posts linking here branch in above it,
// posts it links to branch out below.
export function PostLinkGraph({ title, links }: { title: string; links: PostLinks<PostSummary> }) {
  const { incoming, outgoing } = links
  return (
    <aside id="links" className="link-graph" aria-labelledby="link-graph-heading">
      <h2 id="link-graph-heading" className="eyebrow">
        🕸️ Linked posts
      </h2>
      <div className="link-graph-tree">
        {incoming.length > 0 && <Branch label="Linked from" posts={incoming} dir="in" />}
        <p
          className={[
            'link-graph-row link-graph-self',
            incoming.length === 0 && 'is-first',
            outgoing.length === 0 && 'is-last',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-current="page"
        >
          <span className="link-graph-node" aria-hidden="true" />
          {title}
        </p>
        {outgoing.length > 0 && <Branch label="Links to" posts={outgoing} dir="out" />}
      </div>
    </aside>
  )
}
