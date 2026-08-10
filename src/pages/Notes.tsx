import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { NoteText } from '../components/NoteText'
import { formatRelative, formatTime } from '../lib/datetime'
import { imageUrl } from '../lib/images'
import {
  fetchNotes,
  fetchOlderNotes,
  notePath,
  NOTES_FEED_URL,
  type Note,
} from '../lib/notes'
import { pageSchema } from '../lib/structuredData'

const AVATAR = imageUrl('/images/about/cailin.webp')

// The microblog: short thoughts, newest first, nothing else on the page.
//
// ## Why this looks nothing like /blog
//
// The blog is an essay you sit down with — it earns a title, a reading time,
// tags, related posts, a provenance line, and a source toggle. A note is a
// sentence. Every one of those affordances applied to a sentence would be
// furniture around a thing smaller than the furniture, so the page has none of
// them: no titles, no tags, no cards. One column, a hairline between notes,
// and a timestamp that is also the permalink. The avatar repeats down the feed
// on purpose — there's only ever one author — so a page of short entries reads
// as a stream of someone's thoughts rather than a changelog.
//
// ## Why it fetches instead of prerendering
//
// Notes live in D1 and are published from a phone; the whole point is that one
// is live seconds after it is typed, without a build. So this page is a static
// shell and the notes arrive over fetch, the same arrangement /listening and
// /reading use. The cost is that a note has no prerendered page of its own and
// isn't visible to a crawler — the Worker's RSS feed is what keeps it
// syndicable. See the header of worker-notes/src/index.ts.
//
// ## Why a permalink pages through the feed instead of fetching by id
//
// The Worker's only read endpoint is `/notes.json`, paged newest-first — there
// is no `GET /notes/:id`. So landing on `/notes#<id>` walks that same paging
// cursor, checking each page for the id, until it turns up or the feed runs
// out. A recent note resolves in one request; a very old one costs a request
// per page between here and there. That's the accepted trade for not standing
// up a second endpoint behind a feature reached by clicking a timestamp, not
// by search traffic.

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

// ---- share -----------------------------------------------------------------

const SHARE_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3v12" />
    <path d="m7.5 7.5 4.5-4.5 4.5 4.5" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </svg>
)

/**
 * Native share sheet where one exists, a clipboard copy where it doesn't.
 * Mirrors the copy button in CurlHint/PostSource: a transient label plus an
 * aria-live echo, since the icon alone says nothing happened.
 */
function ShareButton({ id, text }: { id: string; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])

  const share = async () => {
    const url = `${window.location.origin}${notePath(id)}`
    if (navigator.share) {
      try {
        await navigator.share({ url, text })
      } catch (err) {
        // AbortError: the share sheet was closed without picking anything — not a failure.
        if ((err as Error)?.name !== 'AbortError') setState('failed')
      }
      return
    }
    try {
      // Absent outside secure contexts, so this can genuinely be unavailable.
      await navigator.clipboard.writeText(url)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <button type="button" className="note-share" onClick={share} aria-label="Share this note">
      <span aria-hidden="true">{SHARE_ICON}</span>
      {state !== 'idle' && (
        <span className="note-share-label" aria-hidden="true">
          {state === 'copied' ? 'Copied' : 'Copy failed'}
        </span>
      )}
      <span role="status" aria-live="polite" className="visually-hidden">
        {state === 'copied' ? 'Link copied to clipboard' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </button>
  )
}

// ---- one note's markup, shared by the feed and the permalink view ---------

function NoteRow({ note }: { note: Note }) {
  return (
    <>
      <img className="note-avatar" src={AVATAR} alt="" loading="lazy" decoding="async" />
      <div className="note-content">
        <div className="note-body">
          <NoteText text={note.text} />
        </div>
        <p className="note-meta">
          <Link className="note-permalink" to={notePath(note.id)}>
            <time dateTime={isoOf(note.createdAt)} title={isoOf(note.createdAt)}>
              {stamp(note.createdAt)}
            </time>
          </Link>
          {/* Said out loud rather than hidden: a permalink that quietly changes
              what it says is the thing worth avoiding, not the edit. */}
          {note.editedAt && (
            <span className="note-edited" title={isoOf(note.editedAt)}>
              edited
            </span>
          )}
          <span className="note-clock">{formatTime(note.createdAt)}</span>
          <ShareButton id={note.id} text={note.text} />
        </p>
      </div>
    </>
  )
}

// ---- the feed ---------------------------------------------------------------

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

function NotesFeed() {
  const { notes, cursor, ready, error, loading, loadMore } = useNotes()

  return (
    <>
      {/* Nothing renders until the fetch lands, and nothing at all if it
          fails — same contract as every other Worker-backed page here. The
          shell above is prerendered and always present. */}
      {error && (
        <p className="notes-empty">
          The notes are not loading right now. They are still there — try again in a moment, or
          read <a href={NOTES_FEED_URL}>the feed</a>.
        </p>
      )}

      {ready && !notes.length && !error && <p className="notes-empty">Nothing here yet.</p>}

      {notes.length > 0 && (
        <ol className="note-list">
          {notes.map((note) => (
            <li key={note.id} className="note">
              <NoteRow note={note} />
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
    </>
  )
}

// ---- a single note, addressed by permalink ---------------------------------

function useSingleNote(id: string): { note: Note | null | undefined; error: boolean } {
  // undefined: still resolving. null: paged through the whole feed and never found it.
  const [note, setNote] = useState<Note | null | undefined>(undefined)
  const [error, setError] = useState(false)

  useEffect(() => {
    setNote(undefined)
    setError(false)
    let cancelled = false
    const controller = new AbortController()

    async function resolve() {
      try {
        let page = await fetchNotes(controller.signal)
        for (;;) {
          const found = page.notes.find((candidate) => candidate.id === id)
          if (found) {
            if (!cancelled) setNote(found)
            return
          }
          if (!page.nextCursor) {
            if (!cancelled) setNote(null)
            return
          }
          page = await fetchOlderNotes(page.nextCursor, PAGE, controller.signal)
        }
      } catch (err) {
        if ((err as { name?: string })?.name !== 'AbortError' && !cancelled) setError(true)
      }
    }

    resolve()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [id])

  return { note, error }
}

function SingleNote({ id }: { id: string }) {
  const { note, error } = useSingleNote(id)
  const ref = useRef<HTMLDivElement>(null)

  // Move focus to the note once it resolves — the equivalent, for a page that
  // is now just this one note, of the scroll-and-focus a permalink used to do
  // inside the full list.
  useEffect(() => {
    if (note) ref.current?.focus()
  }, [note])

  if (error) {
    return (
      <p className="notes-empty">
        That note isn't loading right now. Try again in a moment, or see{' '}
        <Link to="/notes">all notes</Link>.
      </p>
    )
  }

  if (note === undefined) {
    return <p className="notes-empty">Loading…</p>
  }

  if (note === null) {
    return (
      <p className="notes-empty">
        That note isn't here anymore — it may have been deleted.{' '}
        <Link to="/notes">See all notes</Link>.
      </p>
    )
  }

  return (
    <div ref={ref} className="note is-solo" tabIndex={-1}>
      <NoteRow note={note} />
    </div>
  )
}

// ---- page -------------------------------------------------------------------

function useNoteId(): string | null {
  const { hash } = useLocation()
  return hash.replace(/^#/, '') || null
}

export function Component() {
  const id = useNoteId()

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
        {id ? (
          <p className="notes-back">
            <Link to="/notes">← All notes</Link>
          </p>
        ) : (
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
        )}

        {id ? <SingleNote id={id} /> : <NotesFeed />}
      </section>
    </>
  )
}
