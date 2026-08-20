// Pure parser: takes one `git log` output and returns a map, so the plugin that shells out
// to git (cailinpitt:post-history in vite.config.ts) stays thin and this stays testable.
// Bulk commits (the 31-post Squarespace import, its reformat) are recorded but not counted
// as "edits", so a post's revision count reflects only what happened to it individually.

import type { DiffRow } from './diff'

/** A commit that touched a post. */
export interface Revision {
  sha: string
  /** Author date, ISO 8601 with offset. */
  date: string
  /** Commit subject line. */
  subject: string
  /** How many posts this commit touched — 1 for an ordinary edit. */
  posts: number
  /** Track-changes rows for this post. Absent for the commit that added it (diff is the post itself). */
  diff?: DiffRow[]
  /** Whether rows were dropped from `diff` to keep the page small. */
  truncated?: boolean
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

// Posts-per-commit at which it stops being an edit and starts being a batch operation —
// two could be a person fixing a typo in two related posts; three has only ever been a script.
export const BULK_POSTS = 3

/** The record and field separators asked of `git log --format` — see gitLogArgs. */
const RECORD = '\x1e'
const FIELD = '\x1f'

// Kept next to the parser so the two can't drift. Separators are control characters that
// can't occur in a subject line.
export const gitLogArgs = (dir: string): string[] => [
  'log',
  `--format=${RECORD}%H${FIELD}%aI${FIELD}%s`,
  '--name-only',
  '--',
  dir,
]

// Shared by the line at the foot of a post and the link at the top, so the two can't
// disagree on the count.
export const editedLabel = (revisions: number): string | null =>
  revisions === 0 ? null : `Edited ${revisions === 1 ? 'once' : `${revisions} times`}`

// `--unified=0` because in markdown the context around a changed paragraph is a blank line;
// `--format=''` drops the commit header, which this module already has.
export const gitShowArgs = (sha: string, dir: string): string[] => [
  'show',
  sha,
  '--unified=0',
  '--format=',
  '--no-color',
  '--',
  dir,
]

// Keyed by file path exactly as git printed it. Commits arrive newest-first and stay that way.
export function parsePostHistory(log: string): Record<string, PostHistory> {
  const commits: { sha: string; date: string; subject: string; files: string[] }[] = []
  for (const record of log.split(RECORD)) {
    if (!record.trim()) continue
    const [header, ...rest] = record.split('\n')
    const [sha, date, ...subject] = header.split(FIELD)
    if (!sha || !date) continue
    const files = rest.map((line) => line.trim()).filter((line) => line.endsWith('.md'))
    // Merges/renames can report empty --name-only output; skip them.
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
      // A copy per file: a bulk commit appears in 31 histories, each getting its own `diff`.
      ;(history[file] ??= { added: null, imported: false, revisions: 0, commits: [] }).commits.push({
        ...revision,
      })
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

// Handles both forms GitHub hands out: an https clone URL and an SSH one.
export function repoWebUrl(remote: string): string | null {
  const url = remote.trim().replace(/\.git$/, '')
  const ssh = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  return /^https?:\/\//.test(url) ? url : null
}
