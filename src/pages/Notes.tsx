import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { NoteText } from '../components/NoteText'
import { formatRelative, formatTime } from '../lib/datetime'
import {
  fetchNotes,
  fetchOlderNotes,
  notePath,
  NOTES_FEED_URL,
  type Note,
} from '../lib/notes'
import { pageSchema } from '../lib/structuredData'

// The microblog: short thoughts, newest first, nothing else on the page.
//
// ## Why this looks nothing like /blog
//
// The blog is an essay you sit down with — it earns a title, a reading time,
// tags, related posts, a provenance line, and a source toggle. A note is a
// sentence. Every one of those affordances applied to a sentence would be
// furniture around a thing smaller than the furniture, so the page has none of
// them: no titles, no tags, no cards, no author, no counts. One column, a
// hairline between notes, and a timestamp that is also the permalink.
//
// ## Why it fetches instead of prerendering
//
// Notes live in D1 and are published from a phone; the whole point is that one
// is live seconds after it is typed, without a build. So this page is a static
// shell and the notes arrive over fetch, the same arrangement /listening and
// /reading use. The cost is that a note has no prerendered page of its own and
// isn't visible to a crawler — the Worker's RSS feed is what keeps it
// syndicable. See the header of worker-notes/src/index.ts.

/** Notes per page. Matches PAGE_SIZE on the Worker. */
const PAGE = 25

/**
 * A note's timestamp, in the reader's own zone: relative for the first day, then
 * the date. A microblog is mostly read at the top, where "20m ago" is what the
 * reader wants to know; further down, "20m ago" would be absurd and the calendar
 * date is the useful thing.
 */
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' })
const dateYearFmt = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})

function stamp(uts: number): string {
  const age = Date.now() / 1000 - uts
  if (age < 86_400) return formatRelative(uts)
  const date = new Date(uts * 1000)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return sameYear ? dateFmt.format(date) : dateYearFmt.format(date)
}

/** The full stamp, for the `title` tooltip and the machine-readable attribute. */
const isoOf = (uts: number) => new Date(uts * 1000).toISOString()

function useNotes() {
  const [notes, setNotes] = useState<Note[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchNotes(controller.signal)
      .then((page) => {
        setNotes(page.notes)
        setCursor(page.nextCursor)
        setReady(true)
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(true)
      })
    return () => controller.abort()
  }, [])

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return
    setLoading(true)
    try {
      const page = await fetchOlderNotes(cursor, PAGE)
      setNotes((current) => [...current, ...page.notes])
      setCursor(page.nextCursor)
    } catch {
      // A failed page leaves what's already on screen alone; the button stays.
    } finally {
      setLoading(false)
    }
  }, [cursor, loading])

  return { notes, cursor, ready, error, loading, loadMore }
}

/**
 * Scroll to and highlight the note named in the URL fragment.
 *
 * A permalink is `/notes#<id>`, and the browser's own fragment handling fires
 * before the notes have been fetched — the element doesn't exist yet, so nothing
 * happens. This re-runs the jump once the feed has rendered. The highlight is
 * what makes the landing legible: without it you arrive in the middle of a list
 * of similar-looking paragraphs with no indication which one you were sent to.
 */
function useFragmentTarget(ready: boolean): string | null {
  const { hash } = useLocation()
  const id = hash.replace(/^#/, '') || null
  const jumped = useRef<string | null>(null)

  useEffect(() => {
    if (!ready || !id || jumped.current === id) return
    const el = document.getElementById(id)
    if (!el) return
    jumped.current = id
    el.scrollIntoView({ block: 'center' })
  }, [ready, id])

  return id
}

export function Component() {
  const { notes, cursor, ready, error, loading, loadMore } = useNotes()
  const target = useFragmentTarget(ready)

  return (
    <>
      <Seo
        title="Notes"
        description="Short thoughts from Cailin Pitt, posted as they happen."
        path="/notes"
        card={{ kicker: 'Notes', meta: 'Short thoughts, posted as they happen' }}
        feed={{ href: NOTES_FEED_URL, title: 'Cailin Pitt — Notes' }}
        jsonLd={pageSchema({
          path: '/notes',
          title: 'Notes',
          description: 'Short thoughts from Cailin Pitt, posted as they happen.',
          type: 'CollectionPage',
        })}
      />

      <section className="notes">
        <header className="notes-header">
          <h1>Notes</h1>
          <p className="notes-lead">
            Short thoughts, posted as they happen. Longer things are on the{' '}
            <Link to="/blog">blog</Link>.
          </p>
          {/* A plain <a>: the feed is served by the Worker, not by this site. */}
          <p className="notes-subscribe">
            <a href={NOTES_FEED_URL} type="application/rss+xml">
              Subscribe via RSS
            </a>
          </p>
        </header>

        {/* Nothing renders until the fetch lands, and nothing at all if it
            fails — same contract as every other Worker-backed page here. The
            shell above is prerendered and always present. */}
        {error && (
          <p className="notes-empty">
            The notes are not loading right now. They are still there — try again in a
            moment, or read <a href={NOTES_FEED_URL}>the feed</a>.
          </p>
        )}

        {ready && !notes.length && !error && <p className="notes-empty">Nothing here yet.</p>}

        {notes.length > 0 && (
          <ol className="note-list">
            {notes.map((note) => (
              <li
                key={note.id}
                id={note.id}
                className={note.id === target ? 'note is-target' : 'note'}
                // The permalink target. tabIndex so the browser can move focus
                // here on a fragment navigation, which is what makes the jump
                // work for a keyboard or screen-reader user and not only
                // visually.
                tabIndex={-1}
              >
                <div className="note-body">
                  <NoteText text={note.text} />
                </div>
                <p className="note-meta">
                  <a className="note-permalink" href={notePath(note.id)}>
                    <time dateTime={isoOf(note.createdAt)} title={`${isoOf(note.createdAt)}`}>
                      {stamp(note.createdAt)}
                    </time>
                  </a>
                  {/* Said out loud rather than hidden: a permalink that quietly
                      changes what it says is the thing worth avoiding, not the
                      edit. */}
                  {note.editedAt && (
                    <span className="note-edited" title={isoOf(note.editedAt)}>
                      edited
                    </span>
                  )}
                  <span className="note-clock">{formatTime(note.createdAt)}</span>
                </p>
              </li>
            ))}
          </ol>
        )}

        {cursor && (
          <p className="notes-more">
            <button type="button" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Older notes'}
            </button>
          </p>
        )}
      </section>
    </>
  )
}
