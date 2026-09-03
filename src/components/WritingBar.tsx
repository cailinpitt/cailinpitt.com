import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatDayStamp } from '../lib/datetime'
import { formatDate } from '../lib/posts'

interface LatestPost {
  path: string
  title: string
  date: string
}

// The newest blog post, for the homepage — counterpart to the other "Lately"
// cards, but fed from the build-time post index rather than a Worker, so it's
// there on first paint with no fetch.
export function WritingBar({ post }: { post: LatestPost | null }) {
  // Server-render the plain date, then sharpen to Today/Yesterday on the client:
  // the page is static and can outlive the day it was built.
  const [label, setLabel] = useState(() => (post?.date ? formatDate(post.date) : null))
  useEffect(() => {
    if (post?.date) setLabel(formatDayStamp(post.date))
  }, [post?.date])

  if (!post) return null

  return (
    <div className="now-bar">
      <Link className="now-bar-main" to={post.path} aria-label="Latest post">
        <span className="now-bar-art moving-bar-mark" aria-hidden="true">
          ✏️
        </span>
        <span className="now-bar-text">
          <span className="now-bar-label">Last posted{label ? ` · ${label}` : ''}</span>
          <span className="now-bar-track">
            <span className="now-bar-title">{post.title}</span>
          </span>
        </span>
      </Link>
    </div>
  )
}
