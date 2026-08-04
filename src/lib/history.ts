/**
 * What git knows about a post, as data the page can render.
 *
 * The parsing here is pure — it takes the output of one `git log` and returns a
 * map — so the plugin that shells out to git (cailinpitt:post-history in
 * vite.config.ts) stays a few lines, and the interesting part is testable.
 *
 * ## Why commits get filtered
 *
 * This repo's history starts in June 2026, when 31 posts arrived from
 * Squarespace in a single commit and were reformatted the next day in a second
 * one. Counting those as edits would tell every pre-2026 post the same lie:
 * "revised twice", describing the repo's own plumbing rather than anything that
 * happened to the writing. So a commit that rewrites many posts at once is
 * recorded but not counted, and a post says only what's true of it: when it
 * entered the repo, and how many times it alone was changed after that.
 */

/** A commit that touched a post. */
export interface Revision {
  sha: string
  /** Author date, ISO 8601 with offset. */
  date: string
  /** Commit subject line. */
  subject: string
  /** How many posts this commit touched — 1 for an ordinary edit. */
  posts: number
}

export interface PostHistory {
  /** ISO date the file first appeared in the repo. Null if git said nothing. */
  added: string | null
  /** Whether it arrived as part of a bulk commit, i.e. the migration. */
  imported: boolean
  /** Commits that changed this post alone, after the one that added it. */
  revisions: number
  /** Every commit that touched it, newest first, bulk ones included. */
  commits: Revision[]
}

/**
 * Posts in one commit at which it stops being an edit and starts being a batch
 * operation. Two is still plausibly a person fixing the same typo in a pair of
 * related posts; three at once has only ever been a script or a reformat.
 */
export const BULK_POSTS = 3

/** The record and field separators asked of `git log --format` — see gitLogArgs. */
const RECORD = '\x1e'
const FIELD = '\x1f'

/**
 * The exact `git log` this module parses. Kept next to the parser so the two
 * can't drift: `--name-only` lists the files each commit touched, and the
 * separators are control characters that can't occur in a subject line.
 */
export const gitLogArgs = (dir: string): string[] => [
  'log',
  `--format=${RECORD}%H${FIELD}%aI${FIELD}%s`,
  '--name-only',
  '--',
  dir,
]

/**
 * Post histories keyed by file path, exactly as git printed them (e.g.
 * `content/blog/california.md`). Commits arrive newest-first and stay that way.
 */
export function parsePostHistory(log: string): Record<string, PostHistory> {
  const commits: { sha: string; date: string; subject: string; files: string[] }[] = []
  for (const record of log.split(RECORD)) {
    if (!record.trim()) continue
    const [header, ...rest] = record.split('\n')
    const [sha, date, ...subject] = header.split(FIELD)
    if (!sha || !date) continue
    const files = rest.map((line) => line.trim()).filter((line) => line.endsWith('.md'))
    // A commit that touched no post at all can't be history for one. It reaches
    // here because `git log -- <dir>` also reports merges and renames whose
    // --name-only output is empty.
    if (files.length === 0) continue
    commits.push({ sha, date, subject: subject.join(FIELD), files })
  }

  const history: Record<string, PostHistory> = {}
  for (const commit of commits) {
    const revision: Omit<Revision, 'posts'> & { posts: number } = {
      sha: commit.sha,
      date: commit.date,
      subject: commit.subject,
      posts: commit.files.length,
    }
    for (const file of commit.files) {
      ;(history[file] ??= { added: null, imported: false, revisions: 0, commits: [] }).commits.push(
        revision,
      )
    }
  }

  for (const entry of Object.values(history)) {
    // Newest first out of git, so the oldest commit is the one that added it.
    const origin = entry.commits[entry.commits.length - 1]
    entry.added = origin.date
    entry.imported = origin.posts >= BULK_POSTS
    entry.revisions = entry.commits
      .slice(0, -1)
      .filter((commit) => commit.posts < BULK_POSTS).length
  }
  return history
}

/**
 * The browsable URL of a git remote, or null for one this can't linkify.
 * Handles both forms GitHub hands out: an https clone URL and an SSH one.
 */
export function repoWebUrl(remote: string): string | null {
  const url = remote.trim().replace(/\.git$/, '')
  const ssh = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  return /^https?:\/\//.test(url) ? url : null
}
