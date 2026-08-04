import { useState } from 'react'
import { formatDate } from '../lib/posts'
import { BULK_POSTS, editedLabel, type PostHistory as History } from '../lib/history'
import type { DiffRow } from '../lib/diff'

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
/**
 * One commit's changes as track-changes prose: the paragraph as it stands, with
 * what was taken out struck through and what went in marked.
 *
 * `<ins>`/`<del>` rather than colored spans, so the change is in the markup and
 * not only in the styling — a screen reader announces it, and a reader with a
 * different palette still sees the strike. Rows are the post's source lines, so
 * `*asterisks*` and link syntax show through; that's the same text the Markdown
 * view at the top of the page shows, and hiding it would mean re-rendering
 * markdown that has been cut in half.
 */
function Diff({ rows, truncated }: { rows: DiffRow[]; truncated?: boolean }) {
  return (
    <div className="post-diff">
      {rows.map((row, index) =>
        row.kind === 'changed' ? (
          <p key={index} className="post-diff-row">
            {row.tokens.map((token, n) =>
              token.kind === 'add' ? (
                <ins key={n}>{token.text}</ins>
              ) : token.kind === 'del' ? (
                <del key={n}>{token.text}</del>
              ) : token.kind === 'gap' ? (
                // Unchanged prose between two edits, cut out so the edits sit
                // next to each other instead of a paragraph apart.
                <span key={n} className="post-diff-gap" title="unchanged text">
                  {token.text}
                </span>
              ) : (
                <span key={n}>{token.text}</span>
              ),
            )}
          </p>
        ) : (
          <p key={index} className={`post-diff-row post-diff-${row.kind}`}>
            {row.kind === 'add' ? <ins>{row.text}</ins> : <del>{row.text}</del>}
          </p>
        ),
      )}
      {truncated && <p className="post-diff-more">Longer than shown — see the commit.</p>}
    </div>
  )
}

export function PostHistory({
  history,
  repo,
  open,
  onToggle,
}: {
  history: History & { file: string }
  /** Repo web URL, or null when the build couldn't find a remote to link to. */
  repo: string | null
  /** Controlled by the page, so the link at the top of the post can open it. */
  open: boolean
  onToggle: (open: boolean) => void
}) {
  /** Sha of the one commit whose diff is open — at most one at a time. */
  const [shown, setShown] = useState<string | null>(null)
  const commitUrl = (sha: string) => (repo ? `${repo}/commit/${sha}` : undefined)

  const edited = editedLabel(history.revisions)
  const summary = edited
    ? `${edited} since ${formatDate(history.added ?? '')}`
    : // Nothing post-specific in the record, so the only honest thing to say
      // is when the file turned up — for most posts that's the migration,
      // years after the date printed at the top of the page.
      `${history.imported ? 'Imported' : 'Added'} ${formatDate(history.added ?? '')}`

  return (
    <aside className="post-history" id="history">
      <p>
        <span>{summary}</span>
        <button type="button" aria-expanded={open} onClick={() => onToggle(!open)}>
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
                {/* The subject opens the diff when there is one to open, and is
                    plain text when there isn't — the commit that added the post
                    has no diff worth showing, since the diff is the post. */}
                {commit.diff ? (
                  <button
                    type="button"
                    className="post-history-subject"
                    aria-expanded={shown === commit.sha}
                    onClick={() => setShown(shown === commit.sha ? null : commit.sha)}
                  >
                    {commit.subject}
                  </button>
                ) : (
                  <span className="post-history-subject">{commit.subject}</span>
                )}
                <span className="post-history-meta">
                  {/* A commit that swept through the whole archive says nothing
                      about this post in particular, and shouldn't read as though
                      it does. */}
                  {commit.posts >= BULK_POSTS && (
                    <span className="post-history-bulk">{commit.posts} posts</span>
                  )}
                  {commitUrl(commit.sha) && (
                    <a href={commitUrl(commit.sha)}>{commit.sha.slice(0, 7)}</a>
                  )}
                </span>
                {shown === commit.sha && commit.diff && (
                  <Diff rows={commit.diff} truncated={commit.truncated} />
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
