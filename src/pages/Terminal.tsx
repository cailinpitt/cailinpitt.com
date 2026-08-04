import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { Link, useLoaderData, useNavigate } from 'react-router-dom'
import { posts as indexedPosts } from 'virtual:site-index'
import { Seo } from '../components/Seo'
import { applyTheme, storedTheme } from '../components/ThemeToggle'
import { pageSchema } from '../lib/structuredData'
import {
  buildTree,
  complete,
  echoLine,
  motd,
  promptPath,
  run,
  type Line,
  type Shell,
  type ShellState,
  type SiteStats,
  type TerminalPhoto,
} from '../lib/terminal'

// The screen and keyboard; the engine is src/lib/terminal.ts.
// Prerenders as a static list of links, replaced by the terminal after mount.

/** Photo ids aren't in the browser build of virtual:site-index, so they ride in loader data. */
type LoaderPhoto = Pick<TerminalPhoto, 'id' | 'year' | 'thumb' | 'alt'>

interface TerminalData {
  photos: LoaderPhoto[]
  stats: SiteStats
}

const toLoaderPhoto = ({ id, year, thumb, alt }: LoaderPhoto): LoaderPhoto => ({
  id,
  year,
  thumb,
  alt,
})

export async function loader(): Promise<TerminalData | null> {
  const summarize = (
    posts: { words: number }[],
    photos: LoaderPhoto[],
  ): TerminalData => ({
    photos: photos.map(toLoaderPhoto),
    stats: {
      posts: posts.length,
      words: posts.reduce((total, post) => total + post.words, 0),
      photos: photos.length,
      years: new Set(photos.map((photo) => photo.year)).size,
    },
  })

  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    const { loadPhotos, loadPostSummaries } = await import('../lib/content.client')
    return summarize(loadPostSummaries(), loadPhotos())
  }
  const { loadPhotos, loadPostSummaries } = await import('../lib/content.server')
  const [posts, photos] = await Promise.all([loadPostSummaries(), loadPhotos()])
  return summarize(posts, photos)
}

function OutputLine({ line }: { line: Line }) {
  const className = line.tone && line.tone !== 'default' ? `tl-${line.tone}` : undefined

  if (line.image) {
    return (
      <div className="tl-image">
        <img src={line.image.src} alt={line.image.alt} loading="lazy" decoding="async" />
      </div>
    )
  }

  let body: ReactNode = line.text || ' '
  if (line.href) {
    // A post's .md is a served file, not a route, so it can't go through <Link>.
    const isFile = line.href.endsWith('.md') || line.href.startsWith('http')
    body = (
      <>
        {line.prefix}
        {isFile ? <a href={line.href}>{line.text}</a> : <Link to={line.href}>{line.text}</Link>}
      </>
    )
  }

  // A listing row: name left, meta right, a leader across the gap.
  if (line.meta) {
    return (
      <div className={`tl-row${className ? ` ${className}` : ''}`}>
        <span>{body}</span>
        <span className="tl-leader" aria-hidden="true" />
        <span className="tl-meta">{line.meta}</span>
      </div>
    )
  }

  return <div className={className}>{body}</div>
}

export function Component() {
  const { photos, stats } = useLoaderData() as TerminalData
  const navigate = useNavigate()

  const [ready, setReady] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [cwd, setCwd] = useState('/')
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  // null means "at the live input".
  const [recall, setRecall] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)

  const tree = useMemo(() => buildTree(indexedPosts, photos), [photos])

  const shell = useMemo<Shell>(
    () => ({
      navigate,
      setTheme: applyTheme,
      theme: () => (typeof window === 'undefined' ? 'system' : storedTheme()),
      now: () => new Date(),
      random: Math.random,
      fetchText: async (url) => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`${res.status}`)
        return res.text()
      },
      fetchNow: async () => (await import('../lib/listening')).fetchNow(),
      fetchReading: async () => (await import('../lib/reading')).fetchReadingNow(),
      fetchGuestbook: async () => (await import('../lib/guestbook')).fetchGuestbook(),
    }),
    [navigate],
  )

  useEffect(() => {
    setReady(true)
    setLines(motd(stats))
  }, [stats])

  // This page is dark whatever the site theme is, so the browser chrome has to be
  // told; index.html's media-scoped tags would leave a paper toolbar above it.
  // Restored on the way out, before ThemeToggle mounts on the next page.
  useEffect(() => {
    const screen = screenRef.current
    if (!screen) return
    const bg = getComputedStyle(screen).getPropertyValue('--tl-bg').trim()
    if (!bg) return
    const tags = [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')]
    const before = tags.map((tag) => tag.content)
    for (const tag of tags) tag.content = bg
    return () => tags.forEach((tag, i) => (tag.content = before[i]))
  }, [])

  // The screen is the page, so following the output down means scrolling the window.
  useEffect(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight })
  }, [lines])

  const submit = useCallback(
    async (raw: string) => {
      const command = raw.trim()
      setInput('')
      setRecall(null)
      if (!command) {
        setLines((current) => [...current, echoLine(cwd, '')])
        return
      }

      setLines((current) => [...current, echoLine(cwd, command)])
      setHistory((current) => [...current, command])
      setBusy(true)
      const state: ShellState = { cwd, tree, stats, photos, history }
      try {
        const result = await run(command, state, shell)
        if (result.clear) setLines([])
        else if (result.lines.length) setLines((current) => [...current, ...result.lines])
        if (result.cwd !== undefined) setCwd(result.cwd)
      } finally {
        setBusy(false)
      }
    },
    [cwd, history, photos, shell, stats, tree],
  )

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      // Not disabled while busy: that would steal focus from the caret.
      if (busy) return
      void submit(input)
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      const state: ShellState = { cwd, tree, stats, photos, history }
      const { input: completed, candidates } = complete(input, state)
      setInput(completed)
      if (candidates.length) {
        setLines((current) => [
          ...current,
          echoLine(cwd, input),
          { text: candidates.join('   '), tone: 'muted' },
        ])
      }
      return
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (!history.length) return
      event.preventDefault()
      const next =
        event.key === 'ArrowUp'
          ? recall === null
            ? history.length - 1
            : Math.max(0, recall - 1)
          : recall === null
            ? null
            : recall + 1
      if (next === null || next >= history.length) {
        setRecall(null)
        setInput('')
        return
      }
      setRecall(next)
      setInput(history[next])
      return
    }

    if (event.key.toLowerCase() === 'l' && event.ctrlKey) {
      event.preventDefault()
      setLines([])
    }
  }

  const description =
    'A shell for this website: list the posts, read one, see what is playing, and sign the guestbook.'

  return (
    <div
      className="terminal-screen"
      ref={screenRef}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a')) return
        if (window.getSelection()?.toString()) return
        inputRef.current?.focus()
      }}
    >
      <Seo
        title="Terminal"
        description={description}
        path="/terminal"
        card={{ layout: 'terminal', kicker: 'Terminal', meta: 'ls · cat · open · now' }}
        jsonLd={pageSchema({ path: '/terminal', title: 'Terminal', description })}
      />
      <h1 className="visually-hidden">Terminal</h1>

      {ready ? (
        <div role="log" aria-live="polite" aria-label="Terminal output">
          {lines.map((line, i) => (
            <OutputLine key={i} line={line} />
          ))}

          <div className="terminal-input-row">
            <label className="visually-hidden" htmlFor="terminal-input">
              Type a command
            </label>
            <span className="tl-prompt" aria-hidden="true">
              {promptPath(cwd)} $
            </span>
            <input
              id="terminal-input"
              ref={inputRef}
              className="terminal-input"
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        </div>
      ) : (
        <div className="terminal-static">
          <p>cailinpitt.com — terminal</p>
          <p>This needs JavaScript. Everything in it is elsewhere on the site too:</p>
          <ul>
            <li>
              <Link to="/blog">/blog</Link> — {stats.posts} posts, each published as its own
              Markdown source
            </li>
            <li>
              <Link to="/photos">/photos</Link> — {stats.photos} photographs across{' '}
              {stats.years} years
            </li>
            <li>
              <Link to="/listening">/listening</Link> · <Link to="/reading">/reading</Link> ·{' '}
              <Link to="/timeline">/timeline</Link>
            </li>
            <li>
              <Link to="/guestbook">/guestbook</Link> · <Link to="/colophon">/colophon</Link> ·{' '}
              <Link to="/">home</Link>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
