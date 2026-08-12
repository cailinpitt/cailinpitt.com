import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLoaderData } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { LinkCard } from '../components/LinkCard'
import { NoteText } from '../components/NoteText'
import { formatRelative } from '../lib/datetime'
import { fetchMoving, longDate, summary as activitySummary, type Activity } from '../lib/moving'
import {
  editNote,
  fetchLinkPreview,
  fetchNotes,
  forgetToken,
  glyphs,
  loadToken,
  MAX_LENGTH,
  notePath,
  publishNote,
  removeNote,
  saveToken,
  segments,
  NoteError,
  type ContextType,
  type LinkPreview,
  type Note,
  type NoteContext,
  type NoteLink,
} from '../lib/notes'
import { resolveContext } from '../lib/notesContext'
import { byNewest, formatPhotoDateShort, type Photo } from '../lib/photos'
import type { PostSummary } from '../lib/posts'

export async function loader(): Promise<PostSummary[] | null> {
  if (!import.meta.env.SSR) {
    if (!import.meta.env.DEV) return null
    return (await import('../lib/content.client')).loadPostSummaries()
  }
  const { loadPostSummaries } = await import('../lib/content.server')
  return loadPostSummaries()
}

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

/**
 * The live, compose-time card — same classes as LinkCard.tsx so it looks
 * identical to what publishing will eventually persist, but built from a raw
 * `fetchLinkPreview` result rather than a Note (no id yet, nothing to
 * re-host until this is actually published). A `<div>`, not an `<a>`, since
 * clicking through mid-draft would lose whatever's been typed.
 */
function ComposeLinkPreview({ preview, loading }: { preview: LinkPreview | null; loading: boolean }) {
  if (loading) return <p className="compose-link-loading">Loading preview…</p>
  if (!preview || (!preview.title && !preview.image)) return null
  return (
    <div className="link-card">
      {preview.image && <img className="link-card-image" src={preview.image} alt="" loading="lazy" />}
      <span className="link-card-body">
        {preview.title && <span className="link-card-title">{preview.title}</span>}
        {preview.description && <span className="link-card-subtitle">{preview.description}</span>}
      </span>
    </div>
  )
}

export function Component() {
  const posts = useLoaderData() as PostSummary[] | null
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
  const contextTypeId = useId()
  const contextRefId = useId()

  // The optional "attach this note to something" picker. Posts come free from
  // the loader above (build-time data, already in the bundle); photos and
  // activities are loaded only once their type is actually picked — a 182KB
  // manifest and a Worker call respectively, neither worth paying for on every
  // visit to this page. See notesContext.ts for how the reference renders once
  // published.
  const [contextType, setContextType] = useState<ContextType | ''>('')
  const [contextRef, setContextRef] = useState('')
  const [photos, setPhotos] = useState<Photo[] | null>(null)
  const [photosLoading, setPhotosLoading] = useState(false)
  const [activities, setActivities] = useState<Activity[] | null>(null)
  const [activitiesLoading, setActivitiesLoading] = useState(false)

  // The link card. `attachCard`/`hideLink` are the two checkboxes; `preview`
  // is the live, unstored scrape shown while composing (see
  // fetchLinkPreview's own comment) — display only, never sent on submit.
  // `seededUrl` covers editing a note whose link was already hidden: its
  // text no longer contains the URL to re-detect, so the url has to come
  // from the note itself rather than from scanning the textarea.
  const [attachCard, setAttachCard] = useState(true)
  const [hideLink, setHideLink] = useState(false)
  const [seededUrl, setSeededUrl] = useState<string | null>(null)
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const detectedUrl = useMemo(() => {
    const link = segments(text).find((s) => s.kind === 'link')
    return link && link.kind === 'link' ? link.href : null
  }, [text])
  const activeUrl = detectedUrl ?? seededUrl

  useEffect(() => {
    if (!attachCard || !activeUrl) {
      setPreview(null)
      setPreviewLoading(false)
      return
    }
    setPreviewLoading(true)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchLinkPreview(activeUrl, token, controller.signal)
        .then((result) => setPreview(result))
        .finally(() => setPreviewLoading(false))
    }, 500)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [attachCard, activeUrl, token])

  const ensureContextList = useCallback(
    (type: ContextType) => {
      if (type === 'photo' && photos === null && !photosLoading) {
        setPhotosLoading(true)
        import('../lib/photos.json')
          .then((mod) => setPhotos([...(mod.default as Photo[])].sort(byNewest)))
          .catch(() => setPhotos([]))
          .finally(() => setPhotosLoading(false))
      }
      if (type === 'activity' && activities === null && !activitiesLoading) {
        setActivitiesLoading(true)
        fetchMoving()
          .then((bundle) => setActivities(bundle.activities))
          .catch(() => setActivities([]))
          .finally(() => setActivitiesLoading(false))
      }
    },
    [photos, photosLoading, activities, activitiesLoading],
  )

  const onContextTypeChange = (value: ContextType | '') => {
    setContextType(value)
    setContextRef('')
    if (value) ensureContextList(value)
  }

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

  const context: NoteContext | null = contextType && contextRef ? { type: contextType, ref: contextRef } : null
  const link: NoteLink | null = attachCard && activeUrl ? { url: activeUrl, hidden: hideLink } : null

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || empty || over || !token) return
    setBusy(true)
    setError(null)
    try {
      const note = editing
        ? await editNote(editing, text, token, context, link)
        : await publishNote(text, token, context, link)
      setText('')
      setEditing(null)
      setContextType('')
      setContextRef('')
      setAttachCard(true)
      setHideLink(false)
      setSeededUrl(null)
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
    setContextType(note.contextType ?? '')
    setContextRef(note.contextRef ?? '')
    if (note.contextType) ensureContextList(note.contextType)
    // Seeded rather than re-detected: a note whose link was already hidden
    // has no URL left in its own text to scan for (see stripLink() in
    // worker-notes/src/index.ts).
    setAttachCard(!!note.linkUrl)
    setHideLink(note.linkHidden)
    setSeededUrl(note.linkHidden ? note.linkUrl : null)
    setPublished(null)
    setError(null)
    boxRef.current?.focus()
  }

  const cancelEdit = () => {
    setEditing(null)
    setText('')
    setContextType('')
    setContextRef('')
    setAttachCard(true)
    setHideLink(false)
    setSeededUrl(null)
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

              <div className="compose-context">
                <label className="visually-hidden" htmlFor={contextTypeId}>
                  Attach to
                </label>
                <select
                  id={contextTypeId}
                  value={contextType}
                  onChange={(event) => onContextTypeChange(event.target.value as ContextType | '')}
                >
                  <option value="">No reference</option>
                  <option value="post">A post</option>
                  <option value="photo">A photo</option>
                  <option value="activity">An activity</option>
                </select>

                {contextType === 'post' && (
                  <select
                    id={contextRefId}
                    aria-label="Choose a post"
                    value={contextRef}
                    onChange={(event) => setContextRef(event.target.value)}
                  >
                    <option value="">Choose a post…</option>
                    {(posts ?? []).map((post) => (
                      <option key={post.path} value={post.path}>
                        {post.title}
                      </option>
                    ))}
                  </select>
                )}

                {contextType === 'photo' &&
                  (photosLoading ? (
                    <span className="compose-context-loading">Loading photos…</span>
                  ) : (
                    <select
                      id={contextRefId}
                      aria-label="Choose a photo"
                      value={contextRef}
                      onChange={(event) => setContextRef(event.target.value)}
                    >
                      <option value="">Choose a photo…</option>
                      {(photos ?? []).map((photo) => (
                        <option key={photo.id} value={photo.id}>
                          {formatPhotoDateShort(photo)} — {photo.alt || photo.id}
                        </option>
                      ))}
                    </select>
                  ))}

                {contextType === 'activity' &&
                  (activitiesLoading ? (
                    <span className="compose-context-loading">Loading activities…</span>
                  ) : (
                    <select
                      id={contextRefId}
                      aria-label="Choose an activity"
                      value={contextRef}
                      onChange={(event) => setContextRef(event.target.value)}
                    >
                      <option value="">Choose an activity…</option>
                      {(activities ?? []).map((activity) => (
                        <option key={activity.id} value={activity.id}>
                          {longDate(activity.startDate)} — {activitySummary(activity)}
                        </option>
                      ))}
                    </select>
                  ))}
              </div>

              {activeUrl && (
                <div className="compose-link">
                  <label>
                    <input
                      type="checkbox"
                      checked={attachCard}
                      onChange={(event) => setAttachCard(event.target.checked)}
                    />
                    Attach a link card
                  </label>
                  {attachCard && (
                    <label>
                      <input
                        type="checkbox"
                        checked={hideLink}
                        onChange={(event) => setHideLink(event.target.checked)}
                      />
                      Hide the link text
                    </label>
                  )}
                  {attachCard && <ComposeLinkPreview preview={preview} loading={previewLoading} />}
                </div>
              )}

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
                  {recent.map((note) => {
                    const noteContext = resolveContext(note.contextType, note.contextRef, {
                      posts: posts ?? undefined,
                      photos: photos ?? undefined,
                      activities: activities ?? undefined,
                    })
                    return (
                    <li key={note.id} className="note">
                      <div className="note-body">
                        <NoteText text={note.text} />
                      </div>
                      <LinkCard note={note} />
                      {noteContext && (
                        <p className="note-context">
                          <span aria-hidden="true">{noteContext.icon}</span> re: {noteContext.text}
                        </p>
                      )}
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
                    )
                  })}
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
