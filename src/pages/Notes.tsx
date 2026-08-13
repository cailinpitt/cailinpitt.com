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
// /reading use. The feed itself still has no prerendered page of its own — but
// a single note now does, at cailinpitt.com/notes/<id>, served at the edge by
// worker-notes rather than built at deploy time. See the header of
// worker-notes/src/index.ts for why that's a Worker route and not a build step.
//
// ## Why landing on /notes#<id> still fetches by id rather than paging
//
// `/notes#<id>` (this hash, not the permalink above) is the SPA's own internal
// address for a note — notePath() in lib/notes.ts. It used to resolve by
// paging through `/notes.json` looking for a match, back when that was the
// only read endpoint. Now that the permalink route exists, `fetchNote(id)`
// asks for that one note directly (a same-origin call to the permalink's own
// `?format=json` view) — one indexed lookup regardless of how old the note is,
// where the old approach cost a request per page between here and there.

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

// ---- one note's markup, shared by the feed and the permalink view ---------

export function NoteRow({ note }: { note: Note }) {
  // /notes never loads photos, activities, or the post list just to label a
  // reference — see the header of notesContext.ts — so this falls back to a
  // generic label ("a photo", "a workout") rather than fetching anything.
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

/** What a query is matched against: the note's own text, lowercased. */
const haystack = (note: Note): string => note.text.toLowerCase()

/**
 * Every whitespace-separated term has to appear somewhere, in any order — same
 * rule the blog index's filter uses, and for the same reason: substring rather
 * than prefix matching, so a query narrows without anyone having to think
 * about word order.
 *
 * This only searches notes already paged into memory client-side — there is no
 * server-side search endpoint, deliberately: a note is short enough that
 * "search" here means "filter what's on screen," and standing up a Worker
 * endpoint for it would be D1 load spent on a feature reached by typing a
 * word, not by search traffic.
 */
function filterNotes(notes: Note[], index: Map<string, string>, query: string): Note[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return notes
  return notes.filter((note) => {
    const text = index.get(note.id) ?? ''
    return terms.every((term) => text.includes(term))
  })
}

/**
 * Every hashtag ever used, for the "browse by tag" cloud at the foot of the
 * feed — same shape as /blog's own tag cloud (collectTags in lib/tags.ts),
 * just fetched from the Worker instead of computed from build-time posts.
 * A failure here costs only the cloud, not the feed above it.
 */
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

      {/* Below the feed rather than above it, same call /blog makes: the
          notes are what someone came for, not the tags. */}
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

// ---- a single note, addressed by permalink ---------------------------------

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
          // Stands in for the site header, which Layout.tsx omits on this
          // route — see the comment on `minimal` there. Without it there is
          // otherwise no way off this page but the browser's back button.
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
