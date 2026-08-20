import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { LinkCard } from '../components/LinkCard'
import { NoteText } from '../components/NoteText'
import { formatRelative, formatTime } from '../lib/datetime'
import { imageUrl } from '../lib/images'
import {
  fetchNote,
  fetchNoteHashtags,
  fetchNotes,
  fetchOlderNotes,
  notePath,
  noteUrl,
  NOTES_FEED_URL,
  type HashtagSummary,
  type Note,
} from '../lib/notes'
import { resolveContext } from '../lib/notesContext'
import { pageSchema } from '../lib/structuredData'

const AVATAR = imageUrl('/images/about/cailin.webp')

// Microblog: short thoughts, newest first, no titles/tags/cards — a sentence
// doesn't need the furniture a blog post gets. Avatar repeats per note since
// there's only one author.
//
// Fetches rather than prerenders: notes are published from a phone and need
// to go live within seconds, same pattern as /listening and /reading. A
// single note does get its own prerendered permalink though, at
// cailinpitt.com/notes/<id>, served by worker-notes (see its header for why
// that's a Worker route, not a build step).
//
// `/notes#<id>` is the SPA's own internal address for a note (notePath() in
// lib/notes.ts). It now resolves via fetchNote(id) — one indexed lookup —
// instead of paging through /notes.json like before the permalink existed.

/** Matches PAGE_SIZE on the Worker. */
const PAGE = 25

// Relative for the first day, then a calendar date — "20m ago" only makes
// sense near the top of the feed.
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

// Native share sheet, or a clipboard copy fallback; transient label plus
// aria-live echo since the icon alone says nothing happened.
function ShareButton({ id, text }: { id: string; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])

  const share = async () => {
    const url = noteUrl(id)
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

// Shared markup for the feed and the permalink view.
export function NoteRow({ note }: { note: Note }) {
  // No fetch just to label a reference — falls back to generic text ("a
  // photo") rather than loading photos/activities/posts; see notesContext.ts.
  const context = resolveContext(note.contextType, note.contextRef)

  return (
    <>
      <img className="note-avatar" src={AVATAR} alt="" loading="lazy" decoding="async" />
      <div className="note-content">
        <div className="note-body">
          <NoteText text={note.text} />
        </div>
        <LinkCard note={note} />
        {context && (
          <p className="note-context">
            <span aria-hidden="true">{context.icon}</span> re:{' '}
            {context.href ? <Link to={context.href}>{context.text}</Link> : context.text}
          </p>
        )}
        <p className="note-meta">
          <Link className="note-permalink" to={notePath(note.id)}>
            <time dateTime={isoOf(note.createdAt)} title={isoOf(note.createdAt)}>
              {stamp(note.createdAt)}
            </time>
          </Link>
          {/* Shown, not hidden: a permalink that silently changes what it says
              is the problem, not the edit itself. */}
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

const haystack = (note: Note): string => note.text.toLowerCase()

// Every term must appear somewhere, any order, substring match — same rule as
// the blog filter. Client-side only, deliberately: no server search endpoint,
// since a note is short enough that "search" just means filtering what's on
// screen.
function filterNotes(notes: Note[], index: Map<string, string>, query: string): Note[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return notes
  return notes.filter((note) => {
    const text = index.get(note.id) ?? ''
    return terms.every((term) => text.includes(term))
  })
}

// Tag cloud data, fetched from the Worker (mirrors collectTags in
// lib/tags.ts for /blog). A failure here only loses the cloud, not the feed.
function useHashtags(): HashtagSummary[] {
  const [tags, setTags] = useState<HashtagSummary[]>([])

  useEffect(() => {
    const controller = new AbortController()
    fetchNoteHashtags(controller.signal)
      .then(setTags)
      .catch(() => {})
    return () => controller.abort()
  }, [])

  return tags
}

function NotesFeed() {
  const { notes, cursor, ready, error, loading, loadMore } = useNotes()
  const [query, setQuery] = useState('')
  const inputId = useId()
  const tags = useHashtags()

  const index = useMemo(() => new Map(notes.map((note) => [note.id, haystack(note)])), [notes])
  const matches = useMemo(() => filterNotes(notes, index, query), [notes, index, query])
  const filtering = query.trim().length > 0

  return (
    <>
      {/* Renders nothing until fetch lands or fails — same contract as other
          Worker-backed pages; shell above is prerendered. */}
      {error && (
        <p className="notes-empty">
          The notes are not loading right now. They are still there — try again in a moment, or
          read <a href={NOTES_FEED_URL}>the feed</a>.
        </p>
      )}

      {ready && !notes.length && !error && <p className="notes-empty">Nothing here yet.</p>}

      {notes.length > 0 && (
        <>
          <div className="notes-filter">
            <label className="visually-hidden" htmlFor={inputId}>
              Filter notes
            </label>
            <input
              id={inputId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter notes…"
              autoComplete="off"
              spellCheck={false}
            />
            {/* Announced on change, same as the blog filter's count. */}
            <p className="notes-count" role="status">
              {filtering ? `${matches.length} of ${notes.length} notes` : `${notes.length} notes`}
            </p>
          </div>

          {matches.length === 0 ? (
            <p className="notes-empty">
              Nothing matches “{query.trim()}”.{' '}
              <button type="button" onClick={() => setQuery('')}>
                Clear the filter
              </button>
              .
            </p>
          ) : (
            <ol className="note-list">
              {matches.map((note) => (
                <li key={note.id} className="note">
                  <NoteRow note={note} />
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {cursor && (
        <p className="notes-more">
          <button type="button" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Older notes'}
          </button>
        </p>
      )}

      {/* Below the feed, not above — same call /blog makes; the notes are
          what someone came for. */}
      {tags.length > 0 && (
        <section className="tag-index" aria-labelledby="tags-heading">
          <h2 id="tags-heading" className="eyebrow">
            🏷️ Browse by tag
          </h2>
          <ul className="tag-list is-cloud">
            {tags.map((t) => (
              <li key={t.tag}>
                <Link to={`/notes/tag/${t.tag}`}>
                  #{t.tag}
                  <span className="tag-count-badge">{t.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function useSingleNote(id: string): { note: Note | null | undefined; error: boolean } {
  // undefined: still resolving. null: the Worker has no such note (deleted, or never existed).
  const [note, setNote] = useState<Note | null | undefined>(undefined)
  const [error, setError] = useState(false)

  useEffect(() => {
    setNote(undefined)
    setError(false)
    const controller = new AbortController()

    fetchNote(id, controller.signal)
      .then((found) => setNote(found))
      .catch((err) => {
        if ((err as { name?: string })?.name !== 'AbortError') setError(true)
      })

    return () => controller.abort()
  }, [id])

  return { note, error }
}

function SingleNote({ id }: { id: string }) {
  const { note, error } = useSingleNote(id)
  const ref = useRef<HTMLDivElement>(null)

  // Focus the note once it resolves — equivalent of the scroll-and-focus a
  // permalink used to do inside the full list.
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
          // Stands in for the site header, which Layout.tsx omits on this
          // route (see `minimal` there) — otherwise there's no way off the
          // page but the back button.
          <p className="notes-back">
            <Link to="/" className="notes-back-home">
              Cailin Pitt
            </Link>
            <Link to="/notes">All notes</Link>
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
