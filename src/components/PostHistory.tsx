import { useEffect, useState, type MouseEvent } from 'react'
import { formatDate } from '../lib/posts'
import { jumpToAnchor } from '../lib/anchor'
import { BULK_POSTS, editedLabel, type PostHistory as History } from '../lib/history'
import type { DiffRow } from '../lib/diff'

/** Open state for the panel, lifted above <PostHistory> so #history lands expanded rather than on a collapsed line. */
export function useHistoryPanel() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (window.location.hash !== '#history') return
    setOpen(true)
    // Browser's own jump-to-#history was likely wrong on a cold load — see lib/anchor.ts.
    jumpToAnchor('history')
  }, [])

  const openFromLink = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    setOpen(true)
    // Next frame, so the panel is expanded before anything is measured.
    requestAnimationFrame(() => {
      jumpToAnchor('history')
      // Updates the URL the way an anchor would, so it's shareable and Back works.
      window.history.pushState(null, '', '#history')
    })
  }

  return { open, setOpen, openFromLink }
}

/**
 * One commit's diff as track-changes prose. `<ins>`/`<del>` rather than
 * colored spans, so a screen reader announces the change and it survives a
 * different palette. Rows are the post's raw source lines (not rendered
 * markdown), matching the Markdown view at the top of the page.
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

/**
 * What happened to this post after publishing, from git — a quiet line at the
 * foot of the article until expanded. Summary counts commits touching only
 * this post; expanded list shows every commit, bulk ones flagged (see lib/history.ts).
 */
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
    : // No post-specific record, so just say when the file turned up (often the migration, years after the printed date).
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
                {/* Plain text when there's no diff to open — the commit that added the post has no diff worth showing. */}
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
                  {/* A commit that swept the whole archive says nothing about this post specifically. */}
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
