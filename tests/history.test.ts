import { describe, expect, it } from 'vitest'
import { BULK_POSTS, parsePostHistory, repoWebUrl } from '../src/lib/history'

// The provenance line at the foot of a post is only as trustworthy as this
// parser. What matters is the distinction it draws: a commit that edited one
// post is a revision of that post, and a commit that swept 31 posts at once is
// repo plumbing that must not be counted as one. See src/lib/history.ts.

const RECORD = '\x1e'
const FIELD = '\x1f'

/** Builds the `git log --name-only` output the parser is fed, newest first. */
const log = (commits: { sha: string; date: string; subject: string; files: string[] }[]) =>
  commits
    .map((c) => `${RECORD}${c.sha}${FIELD}${c.date}${FIELD}${c.subject}\n\n${c.files.join('\n')}\n`)
    .join('')

const post = (n: number) => `content/blog/post-${n}.md`
const many = Array.from({ length: 31 }, (_, i) => post(i))

describe('parsePostHistory', () => {
  it('records every commit that touched a file, newest first', () => {
    const history = parsePostHistory(
      log([
        { sha: 'ccc', date: '2026-08-02T10:00:00-05:00', subject: 'typo', files: [post(1)] },
        { sha: 'bbb', date: '2026-08-01T18:00:00-05:00', subject: 'new post', files: [post(1)] },
      ]),
    )
    expect(history[post(1)].commits.map((c) => c.sha)).toEqual(['ccc', 'bbb'])
    expect(history[post(1)].added).toBe('2026-08-01T18:00:00-05:00')
  })

  it('does not count the commit that added a post as a revision of it', () => {
    const history = parsePostHistory(
      log([{ sha: 'bbb', date: '2026-08-01T18:00:00-05:00', subject: 'new', files: [post(1)] }]),
    )
    expect(history[post(1)].revisions).toBe(0)
    expect(history[post(1)].imported).toBe(false)
  })

  it('counts an ordinary edit', () => {
    const history = parsePostHistory(
      log([
        { sha: 'ccc', date: '2026-08-02T10:00:00-05:00', subject: 'typo', files: [post(1)] },
        { sha: 'bbb', date: '2026-08-01T18:00:00-05:00', subject: 'new', files: [post(1)] },
      ]),
    )
    expect(history[post(1)].revisions).toBe(1)
  })

  it('does not count a commit that rewrote the whole archive', () => {
    // The real shape of this repo: a migration, then a reformat of all 31, and
    // one post edited on its own afterward.
    const history = parsePostHistory(
      log([
        { sha: 'ddd', date: '2026-07-01T09:00:00-05:00', subject: 'fix', files: [post(1)] },
        { sha: 'ccc', date: '2026-06-21T16:00:00-05:00', subject: 'Polish', files: many },
        { sha: 'bbb', date: '2026-06-20T12:00:00-05:00', subject: 'migration', files: many },
      ]),
    )
    expect(history[post(1)].revisions).toBe(1)
    // …and a post the bulk commits touched but nobody edited since claims nothing.
    expect(history[post(2)].revisions).toBe(0)
    expect(history[post(2)].commits).toHaveLength(2)
  })

  it('marks a post that arrived in a bulk commit as imported', () => {
    const history = parsePostHistory(
      log([{ sha: 'bbb', date: '2026-06-20T12:00:00-05:00', subject: 'migration', files: many }]),
    )
    expect(history[post(0)].imported).toBe(true)
    expect(history[post(0)].added).toBe('2026-06-20T12:00:00-05:00')
  })

  it('draws the bulk line at BULK_POSTS', () => {
    const files = Array.from({ length: BULK_POSTS - 1 }, (_, i) => post(i))
    const history = parsePostHistory(
      log([
        { sha: 'ccc', date: '2026-08-02T10:00:00-05:00', subject: 'both', files },
        { sha: 'bbb', date: '2026-08-01T18:00:00-05:00', subject: 'new', files: [post(0)] },
      ]),
    )
    // One under the threshold is still a person editing two related posts.
    expect(history[post(0)].revisions).toBe(1)
  })

  it('ignores commits that touched no post', () => {
    // `git log -- <dir>` reports merges with empty --name-only output.
    const history = parsePostHistory(
      log([
        { sha: 'mmm', date: '2026-08-03T10:00:00-05:00', subject: 'Merge branch', files: [] },
        { sha: 'bbb', date: '2026-08-01T18:00:00-05:00', subject: 'new', files: [post(1)] },
      ]),
    )
    expect(history[post(1)].commits).toHaveLength(1)
  })

  it('keeps a subject that contains whatever a subject contains', () => {
    const history = parsePostHistory(
      log([
        {
          sha: 'bbb',
          date: '2026-08-01T18:00:00-05:00',
          subject: 'Read alt and taken from X-Photo-* headers too',
          files: [post(1)],
        },
      ]),
    )
    expect(history[post(1)].commits[0].subject).toBe(
      'Read alt and taken from X-Photo-* headers too',
    )
  })

  it('returns nothing for an empty log rather than throwing', () => {
    expect(parsePostHistory('')).toEqual({})
  })
})

describe('repoWebUrl', () => {
  it('normalizes both forms GitHub hands out', () => {
    expect(repoWebUrl('https://github.com/cailinpitt/cailinpitt.com.git\n')).toBe(
      'https://github.com/cailinpitt/cailinpitt.com',
    )
    expect(repoWebUrl('git@github.com:cailinpitt/cailinpitt.com.git\n')).toBe(
      'https://github.com/cailinpitt/cailinpitt.com',
    )
  })

  it('declines to linkify a remote it does not understand', () => {
    expect(repoWebUrl('/srv/git/site.git')).toBeNull()
  })
})
