import { useCallback, useEffect, useRef, useState } from 'react'
import { CommentForm } from './CommentForm'
import { formatNumber, formatRelative } from '../lib/datetime'
import {
  displayHost,
  fetchComments,
  fetchOlderComments,
  type Comment,
  type CommentPage,
} from '../lib/comments'

// Mirrors Guestbook.tsx's fetch/load-more logic, scoped to one postPath.
export function CommentsSection({ postPath }: { postPath: string }) {
  const [page, setPage] = useState<CommentPage | null>(null)
  const [error, setError] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setPage(null)
    setError(false)
    const controller = new AbortController()
    fetchComments(postPath, controller.signal)
      .then(setPage)
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(true)
      })
    return () => controller.abort()
  }, [postPath])

  useEffect(() => () => controllerRef.current?.abort(), [])

  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const older = await fetchOlderComments(postPath, cursor, 25, controller.signal)
      setPage((prev) => {
        if (!prev) return prev
        const seen = new Set(prev.comments.map((c) => c.id))
        return {
          comments: [...prev.comments, ...older.comments.filter((c) => !seen.has(c.id))],
          nextCursor: older.nextCursor,
          total: older.total,
        }
      })
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setPage((prev) => (prev ? { ...prev, nextCursor: null } : prev))
      }
    } finally {
      setLoadingMore(false)
    }
  }, [postPath, page?.nextCursor, loadingMore])

  // Prepend directly instead of refetching — the read endpoint's 30s edge
  // cache would otherwise hide a just-posted comment.
  const onPosted = useCallback((comment: Comment) => {
    setPage((prev) =>
      prev
        ? { ...prev, comments: [comment, ...prev.comments], total: prev.total + 1 }
        : { comments: [comment], nextCursor: null, total: 1 },
    )
  }, [])

  return (
    <section className="comments-section" aria-labelledby="comments-heading">
      <h2 id="comments-heading" className="eyebrow">
        💬{' '}
        {page
          ? page.total === 0
            ? 'Comments'
            : `${formatNumber(page.total)} ${page.total === 1 ? 'comment' : 'comments'}`
          : 'Comments'}
      </h2>

      <CommentForm postPath={postPath} onPosted={onPosted} />

      {error && !page ? (
        <p className="comment-load-error">Could not load comments right now. Try again later.</p>
      ) : !page ? (
        <CommentsSkeleton />
      ) : (
        <>
          {page.total === 0 ? (
            <p className="comment-empty">No comments yet. You could be first.</p>
          ) : (
            <ol className="comment-list">
              {page.comments.map((comment) => (
                <CommentItem key={comment.id} comment={comment} />
              ))}
            </ol>
          )}

          {page.nextCursor && (
            <button className="load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load older comments'}
            </button>
          )}
        </>
      )}
    </section>
  )
}

function CommentItem({ comment }: { comment: Comment }) {
  return (
    <li className="comment-item">
      <div className="comment-byline">
        {comment.website ? (
          <a
            className="comment-name"
            href={comment.website}
            target="_blank"
            rel="nofollow ugc noopener noreferrer"
          >
            {comment.name}
          </a>
        ) : (
          <span className="comment-name">{comment.name}</span>
        )}

        <time className="comment-time" dateTime={new Date(comment.createdAt * 1000).toISOString()}>
          {formatRelative(comment.createdAt)}
        </time>
      </div>

      <p className="comment-message">{comment.message}</p>

      {comment.website && (
        <p className="comment-site">
          <a href={comment.website} target="_blank" rel="nofollow ugc noopener noreferrer">
            {displayHost(comment.website)}
          </a>
        </p>
      )}
    </li>
  )
}

function CommentsSkeleton() {
  return (
    <div className="comment-skeleton" aria-hidden="true">
      <div className="sk-card" />
      <div className="sk-card" />
    </div>
  )
}
