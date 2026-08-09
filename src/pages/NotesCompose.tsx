import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Seo } from '../components/Seo'
import { NoteText } from '../components/NoteText'
import { formatRelative } from '../lib/datetime'
import {
  editNote,
  fetchNotes,
  forgetToken,
  glyphs,
  loadToken,
  MAX_LENGTH,
  notePath,
  publishNote,
  removeNote,
  saveToken,
  NoteError,
  type Note,
} from '../lib/notes'

// Writing a note from a computer.
//
// The iOS Shortcut covers the phone, which is where most notes get written. This
// covers everywhere else — and, because it is a page rather than an app, it also
// covers the phone when the Shortcut breaks, a new laptop, or someone else's
// machine. Nothing to install and nothing to keep updated.
//
// ## Why a page on the public site, and what that costs
//
// The alternative was a CLI, which would be safer by construction (a token in
// .env, no browser involved) and useless for the actual problem: not having the
// repo to hand is the whole reason this feature exists. So the compose box is
// here, gated by the same PUBLISH_TOKEN the Shortcut uses, kept in localStorage
// so it is pasted once per device. Anyone can load this page; nobody without the
// token can do anything with it, and the Worker is the thing enforcing that —
// the UI below is a convenience, never the check.
//
// The page is `noindex` and absent from the sitemap. That is tidiness, not
// security: it keeps a compose box out of search results, and nothing more.

/** How many recent notes the page offers for editing. A typo is found fast or not at all. */
const RECENT = 10

/** Under this many characters left, the counter starts saying so. */
const WARN_AT = 60

export function Component() {
  const [token, setToken] = useState('')
  const [tokenLoaded, setTokenLoaded] = useState(false)
  const [text, setText] = useState('')
  const [recent, setRecent] = useState<Note[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [published, setPublished] = useState<Note | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const textId = useId()
  const tokenId = useId()

  // localStorage is not available while prerendering, so the token is read after
  // mount. `tokenLoaded` keeps the page from flashing the "paste your token"
  // state to someone who has already pasted it.
  useEffect(() => {
    setToken(loadToken())
    setTokenLoaded(true)
  }, [])

  const refresh = useCallback((signal?: AbortSignal) => {
    fetchNotes(signal)
      .then((page) => setRecent(page.notes.slice(0, RECENT)))
      .catch(() => {
        // The feed failing to load is not a reason to block writing. The box
        // above works; only the edit list below is missing.
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const left = MAX_LENGTH - glyphs(text)
  const over = left < 0
  const empty = !text.trim()

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || empty || over || !token) return
    setBusy(true)
    setError(null)
    try {
      const note = editing
        ? await editNote(editing, text, token)
        : await publishNote(text, token)
      setText('')
      setEditing(null)
      setPublished(note)
      // Prepend locally as well as refetching: the read endpoint sits behind a
      // 30-second edge cache which the Worker purges on write, but the purge is
      // eventually consistent across colos and the author is the one person
      // guaranteed to look immediately.
      setRecent((current) => [note, ...current.filter((n) => n.id !== note.id)].slice(0, RECENT))
      refresh()
    } catch (err) {
      setError(err instanceof NoteError ? err.message : 'Something went wrong.')
      // A rejected token is almost always a mistyped paste, so drop it and ask
      // again rather than leaving the page in a state where every publish fails.
      if (err instanceof NoteError && err.status === 401) {
        forgetToken()
        setToken('')
      }
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (note: Note) => {
    setEditing(note.id)
    setText(note.text)
    setPublished(null)
    setError(null)
    boxRef.current?.focus()
  }

  const cancelEdit = () => {
    setEditing(null)
    setText('')
  }

  const onDelete = async (note: Note) => {
    // Deleting is immediate and permanent, like `guestbook:rm`, so it asks —
    // this is the one destructive control on the page and it sits next to Edit.
    if (!window.confirm('Delete this note? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      await removeNote(note.id, token)
      setRecent((current) => current.filter((n) => n.id !== note.id))
      if (editing === note.id) cancelEdit()
    } catch (err) {
      setError(err instanceof NoteError ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  // ⌘↵ / Ctrl-↵ publishes, which is the one keyboard convention every compose
  // box has and the only way this is faster than the Shortcut on a laptop.
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  return (
    <>
      <Seo
        title="New note"
        description="Compose a note."
        path="/notes/compose"
        noindex
      />

      <section className="notes compose">
        <header className="notes-header">
          <h1>New note</h1>
        </header>

        {!tokenLoaded ? null : !token ? (
          <form
            className="compose-token"
            onSubmit={(event) => {
              event.preventDefault()
              const value = new FormData(event.currentTarget).get('token')
              if (typeof value === 'string' && value.trim()) {
                saveToken(value.trim())
                setToken(value.trim())
                setError(null)
              }
            }}
          >
            <label htmlFor={tokenId}>Publish token</label>
            <input
              id={tokenId}
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste it once; this device remembers it."
            />
            <button type="submit">Save</button>
            {error && <p className="compose-error">{error}</p>}
          </form>
        ) : (
          <>
            <form className="compose-form" onSubmit={onSubmit}>
              <label className="visually-hidden" htmlFor={textId}>
                Note text
              </label>
              <textarea
                id={textId}
                ref={boxRef}
                className="compose-box"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                rows={5}
                autoFocus
                placeholder={editing ? 'Edit the note…' : 'What are you thinking?'}
                spellCheck
              />

              <div className="compose-bar">
                {/* role="status" so the count is announced as it changes rather
                    than only being visible. */}
                <p
                  className={over ? 'compose-count is-over' : left <= WARN_AT ? 'compose-count is-low' : 'compose-count'}
                  role="status"
                >
                  {over ? `${-left} over` : `${left} left`}
                </p>
                <div className="compose-actions">
                  {editing && (
                    <button type="button" onClick={cancelEdit} disabled={busy}>
                      Cancel
                    </button>
                  )}
                  <button type="submit" disabled={busy || empty || over}>
                    {busy ? '…' : editing ? 'Save changes' : 'Publish'}
                  </button>
                </div>
              </div>

              {error && <p className="compose-error">{error}</p>}
              {published && !error && (
                <p className="compose-done">
                  Published. <a href={notePath(published.id)}>See it →</a>
                </p>
              )}
            </form>

            {recent.length > 0 && (
              <section className="compose-recent" aria-labelledby="recent-notes">
                <h2 id="recent-notes" className="eyebrow">
                  Recent
                </h2>
                <ol className="note-list">
                  {recent.map((note) => (
                    <li key={note.id} className="note">
                      <div className="note-body">
                        <NoteText text={note.text} />
                      </div>
                      <p className="note-meta">
                        <a className="note-permalink" href={notePath(note.id)}>
                          {formatRelative(note.createdAt)}
                        </a>
                        {note.editedAt && <span className="note-edited">edited</span>}
                        <span className="compose-row-actions">
                          <button type="button" onClick={() => startEdit(note)} disabled={busy}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="is-danger"
                            onClick={() => onDelete(note)}
                            disabled={busy}
                          >
                            Delete
                          </button>
                        </span>
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <p className="compose-signout">
              <button
                type="button"
                onClick={() => {
                  forgetToken()
                  setToken('')
                }}
              >
                Forget the token on this device
              </button>
            </p>
          </>
        )}
      </section>
    </>
  )
}
