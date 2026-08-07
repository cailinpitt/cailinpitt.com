// Aliased: React's KeyboardEvent would otherwise shadow the DOM one this file
// also uses, for the document-level listener.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { photoYears, posts } from 'virtual:site-index'
import { yearAnchor } from '../lib/photos'
import { tagSlug } from '../lib/tags'

// Jump-to-anywhere search over everything the site is made of: pages, posts,
// photo years, and tags. The whole index is compiled in (see the site-index plugin
// in vite.config.ts), so opening the palette costs no request and matching is a
// scan over a few hundred short strings — fast enough that debouncing would only
// add latency.
//
// Rendered by Layout: the trigger sits in the header nav, the dialog beside it.

type Kind = 'Page' | 'Post' | 'Photos' | 'Tag'

export interface Entry {
  id: string
  label: string
  /** Secondary line — a date, a count, a description. */
  sub?: string
  kind: Kind
  to: string
  /** Extra words that should match but don't belong in the label. */
  keywords?: string
}

/**
 * The site's own pages, by hand — a route knows its path but not what to call it
 * or what someone might type looking for it, and "listening" being findable as
 * "scrobbles" is the whole point of the list. Posts, photo years, and tags are
 * derived below, so only a genuinely new *page* needs a line here.
 *
 * Exported for tests/command-palette.test.ts, which holds this against the
 * router: a page added to App.tsx and forgotten here is unreachable from ⌘K, and
 * nothing about the palette would look broken.
 */
export const PAGES: Entry[] = [
  { id: 'page:/', label: 'Home', kind: 'Page', to: '/', keywords: 'index start' },
  { id: 'page:/about', label: 'About', kind: 'Page', to: '/about', keywords: 'me bio who cailin' },
  { id: 'page:/now', label: 'Now', kind: 'Page', to: '/now', keywords: 'currently up to today latest' },
  { id: 'page:/blog', label: 'Blog', kind: 'Page', to: '/blog', keywords: 'writing posts essays' },
  { id: 'page:/photos', label: 'Photos', kind: 'Page', to: '/photos', keywords: 'photography feed gallery' },
  { id: 'page:/photos/map', label: 'Photo map', kind: 'Page', to: '/photos/map', keywords: 'where places locations' },
  { id: 'page:/projects', label: 'Projects', kind: 'Page', to: '/projects', keywords: 'software code apps' },
  { id: 'page:/listening', label: 'Listening', kind: 'Page', to: '/listening', keywords: 'music scrobbles last.fm now playing' },
  { id: 'page:/listening/wrapped', label: 'Listening · Wrapped', kind: 'Page', to: '/listening/wrapped', keywords: 'music year in review wrapped stats recap top artists' },
  { id: 'page:/reading', label: 'Reading', kind: 'Page', to: '/reading', keywords: 'books articles hardcover' },
  { id: 'page:/watching', label: 'Watching', kind: 'Page', to: '/watching', keywords: 'films movies letterboxd cinema' },
  { id: 'page:/moving', label: 'Moving', kind: 'Page', to: '/moving', keywords: 'bike cycling ebike rides lifting gym workouts miles' },
  {
    id: 'page:/timeline',
    label: 'Timeline',
    kind: 'Page',
    to: '/timeline',
    // "log" stays a keyword: the page answered to that name until 2026.
    keywords: 'log activity days',
  },
  { id: 'page:/guestbook', label: 'Guestbook', kind: 'Page', to: '/guestbook', keywords: 'sign visitors say hi hello comments' },
  { id: 'page:/terminal', label: 'Terminal', kind: 'Page', to: '/terminal', keywords: 'shell console command line cli ls cat curl' },
  { id: 'page:/uses', label: 'Uses', kind: 'Page', to: '/uses', keywords: 'gear setup hardware software tools desk' },
  { id: 'page:/colophon', label: 'Colophon', kind: 'Page', to: '/colophon', keywords: 'about built stack how' },
  { id: 'page:/privacy', label: 'Privacy', kind: 'Page', to: '/privacy', keywords: 'cookies tracking data' },
]

const yearFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'UTC' })

/** "2023" from an ISO date, or nothing for the undated posts. */
const yearOf = (date: string): string | undefined =>
  /^\d{4}/.test(date) ? yearFmt.format(new Date(`${date.slice(0, 10)}T12:00:00Z`)) : undefined

function buildEntries(): Entry[] {
  const postEntries: Entry[] = posts.map((post) => ({
    id: `post:${post.path}`,
    label: post.title,
    sub: yearOf(post.date),
    kind: 'Post',
    to: post.path,
    keywords: post.tags.join(' '),
  }))

  // The feed is one page, so a year is a place *in* it rather than a page of its
  // own — these land on the first photo of that year.
  const yearEntries: Entry[] = photoYears.map((year) => ({
    id: `photos:${year}`,
    label: year,
    sub: 'Photos',
    kind: 'Photos',
    to: `/photos#${yearAnchor(year)}`,
    keywords: 'photos photography year',
  }))

  // One entry per distinct tag, labeled with the most recent spelling — posts
  // arrive newest first, so the first one to claim a slug wins, which is the
  // same rule collectTags() uses for the cloud at the foot of /blog.
  const tagEntries = new Map<string, Entry>()
  for (const post of posts) {
    for (const tag of post.tags) {
      const slug = tagSlug(tag)
      if (!slug || tagEntries.has(slug)) continue
      tagEntries.set(slug, {
        id: `tag:${slug}`,
        label: tag,
        sub: 'Tag',
        kind: 'Tag',
        to: `/blog/tag/${slug}`,
      })
    }
  }

  return [...PAGES, ...postEntries, ...yearEntries, ...tagEntries.values()]
}

const ENTRIES = buildEntries()

// Precomputed once: matching runs on every keystroke and shouldn't be lowercasing
// the same few hundred strings each time.
const HAYSTACKS = new Map(
  ENTRIES.map((entry) => [entry.id, `${entry.label} ${entry.sub ?? ''} ${entry.keywords ?? ''}`.toLowerCase()]),
)

/** Ranking weight per kind, so an exact-ish tie puts navigation above archive. */
const KIND_RANK: Record<Kind, number> = { Page: 3, Photos: 2, Tag: 1, Post: 0 }

/**
 * How well one term matches: a label prefix beats a word start beats a substring
 * anywhere. Returns 0 when the term is absent, which fails the whole entry —
 * every term has to hit, so typing more always narrows.
 */
function scoreTerm(entry: Entry, haystack: string, term: string): number {
  const label = entry.label.toLowerCase()
  if (label.startsWith(term)) return 12
  if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(haystack)) return 6
  return haystack.includes(term) ? 2 : 0
}

function search(query: string, limit = 12): Entry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) {
    // The resting state is the thing to make useful: everywhere you can go, then
    // the newest few posts.
    return [...PAGES, ...ENTRIES.filter((entry) => entry.kind === 'Post').slice(0, 4)]
  }
  const scored: { entry: Entry; score: number }[] = []
  for (const entry of ENTRIES) {
    const haystack = HAYSTACKS.get(entry.id) ?? ''
    let score = 0
    for (const term of terms) {
      const termScore = scoreTerm(entry, haystack, term)
      if (!termScore) {
        score = 0
        break
      }
      score += termScore
    }
    if (score) scored.push({ entry, score: score + KIND_RANK[entry.kind] })
  }
  // Stable within a score, so posts keep their newest-first order.
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((hit) => hit.entry)
}

/** Whether a keystroke landed somewhere the visitor is actually typing. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  )
}

export function CommandPaletteTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="palette-trigger"
      onClick={onClick}
      aria-label="Search the site"
      title="Search (⌘K)"
    >
      <span aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
    </button>
  )
}

export function CommandPalette({
  open,
  onOpen,
  onClose,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const results = useMemo(() => search(query), [query])

  // Back to the top on every keystroke: the results are re-ranked, so holding on
  // to row 4 would keep a selection that no longer means what it did.
  useEffect(() => setActive(0), [query])

  // ⌘K / Ctrl-K anywhere, and "/" when the visitor isn't already typing into
  // something (the filter on /blog would otherwise swallow its own slash).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const combo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
      const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !isTyping(event.target)
      if (!combo && !slash) return
      event.preventDefault()
      if (open) onClose()
      else onOpen()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onOpen, onClose])

  // Drive the native <dialog> from state — showModal() brings focus trapping,
  // Escape, and an inert background for free, none of which is worth
  // reimplementing.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setQuery('')
      setActive(0)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // Keep the highlighted row visible when arrowing past the fold.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, results])

  const go = useCallback(
    (entry: Entry | undefined) => {
      if (!entry) return
      onClose()
      navigate(entry.to)
    },
    [navigate, onClose],
  )

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!results.length) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      // Wraps: holding an arrow never dead-ends.
      setActive((current) => (current + delta + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      go(results[active])
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="palette"
      aria-label="Search the site"
      onClose={onClose}
      onClick={(event) => {
        // Backdrop click — the dialog element itself is the backdrop's hit target.
        if (event.target === dialogRef.current) onClose()
      }}
    >
      {/* Mounted only while open: the dialog is in the prerendered HTML of every
          page, and an always-present listbox of 60 links is not something a
          screen reader should have to walk past to reach the article. */}
      {open && (
        <div className="palette-inner">
          <input
            className="palette-input"
            type="text"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search posts, photos, pages…"
            aria-label="Search posts, photos, pages"
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            aria-activedescendant={results[active] ? `palette-option-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />

          {results.length === 0 ? (
            <p className="palette-empty">No matches.</p>
          ) : (
            <ul className="palette-results" id="palette-results" role="listbox" ref={listRef}>
              {results.map((entry, i) => (
                <li
                  key={entry.id}
                  id={`palette-option-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'is-active' : undefined}
                  // Pointer selection follows the mouse, so clicking always
                  // activates the row that looks selected.
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(entry)}
                >
                  <span className="palette-label">{entry.label}</span>
                  {entry.sub && <span className="palette-sub">{entry.sub}</span>}
                  <span className="palette-kind">{entry.kind}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="palette-hint" aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move · <kbd>↵</kbd> to open · <kbd>esc</kbd> to close
          </p>
        </div>
      )}
    </dialog>
  )
}
