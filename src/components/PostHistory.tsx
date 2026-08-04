import { useState } from 'react'
import { formatDate } from '../lib/posts'
import { BULK_POSTS, type PostHistory as History } from '../lib/history'

/**
 * What happened to this post after it was published, from git.
 *
 * It sits at the foot of the article, where a newspaper prints its corrections,
 * and stays a single quiet line until asked — the point is that the record
 * exists and can be checked, not that anyone has to read it.
 *
 * The summary counts only commits that changed this post alone; the expanded
 * list shows every commit that touched the file, with the wide ones marked as
 * what they were. That split is the whole design: see src/lib/history.ts for
 * why a count on its own would be misleading here.
 */
export function PostHistory({
  history,
  repo,
}: {
  history: History & { file: string }
  /** Repo web URL, or null when the build couldn't find a remote to link to. */
  repo: string | null
}) {
  const [open, setOpen] = useState(false)
  const commitUrl = (sha: string) => (repo ? `${repo}/commit/${sha}` : undefined)

  const summary =
    history.revisions > 0
      ? `Edited ${history.revisions === 1 ? 'once' : `${history.revisions} times`} since ${formatDate(history.added ?? '')}`
      : // Nothing post-specific in the record, so the only honest thing to say
        // is when the file turned up — for most posts that's the migration,
        // years after the date printed at the top of the page.
        `${history.imported ? 'Imported' : 'Added'} ${formatDate(history.added ?? '')}`

  return (
    <aside className="post-history">
      <p>
        <span>{summary}</span>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide history' : 'Show history'}
        </button>
      </p>
      {open && (
        <>
          {history.imported && (
            <p className="post-history-note">
              This site's git history begins in June 2026, when the archive moved off Squarespace —
              posts written before then all arrived in one commit.
            </p>
          )}
          <ol className="post-history-list">
            {history.commits.map((commit) => (
              <li key={commit.sha}>
                <time dateTime={commit.date}>{formatDate(commit.date.slice(0, 10))}</time>
                <span className="post-history-subject">
                  {commitUrl(commit.sha) ? (
                    <a href={commitUrl(commit.sha)}>{commit.subject}</a>
                  ) : (
                    commit.subject
                  )}
                </span>
                {/* A commit that swept through the whole archive says nothing
                    about this post in particular, and shouldn't read as though
                    it does. */}
                {commit.posts >= BULK_POSTS && (
                  <span className="post-history-bulk">{commit.posts} posts</span>
                )}
              </li>
            ))}
          </ol>
          {repo && (
            <p className="post-history-note">
              <a href={`${repo}/commits/main/${history.file}`}>
                Full history on GitHub<span aria-hidden="true"> ↗</span>
              </a>
            </p>
          )}
        </>
      )}
    </aside>
  )
}
