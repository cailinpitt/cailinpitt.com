import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { fetchNotesByTag, type Note } from '../lib/notes'
import { NoteRow } from './Notes'

// Every note tagged #<tag>, newest first. Client-fetched like the feed itself
// (see Notes.tsx) rather than prerendered — notes live in D1, not build-time
// content, so unlike BlogTag.tsx there's no getStaticPaths/loader.

const PAGE = 25

function useNotesByTag(tag: string) {
  const [notes, setNotes] = useState<Note[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setNotes([])
    setCursor(null)
    setReady(false)
    setError(false)
    const controller = new AbortController()
    fetchNotesByTag(tag, null, PAGE, controller.signal)
      .then((page) => {
        setNotes(page.notes)
        setCursor(page.nextCursor)
        setReady(true)
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(true)
      })
    return () => controller.abort()
  }, [tag])

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return
    setLoading(true)
    try {
      const page = await fetchNotesByTag(tag, cursor, PAGE)
      setNotes((current) => [...current, ...page.notes])
      setCursor(page.nextCursor)
    } catch {
      // A failed page leaves what's already on screen alone; the button stays.
    } finally {
      setLoading(false)
    }
  }, [tag, cursor, loading])

  return { notes, cursor, ready, error, loading, loadMore }
}

export function Component() {
  const { tag = '' } = useParams()
  const { notes, cursor, ready, error, loading, loadMore } = useNotesByTag(tag)
  const path = `/notes/tag/${tag}`

  return (
    <>
      <Seo title={`#${tag}`} description={`Notes tagged #${tag}, from Cailin Pitt.`} path={path} />

      <section className="notes">
        <header className="notes-header">
          <p className="tag-eyebrow">
            <Link to="/notes">← All notes</Link>
          </p>
          <h1>#{tag}</h1>
          {ready && (
            <p className="tag-count">
              {notes.length} {notes.length === 1 ? 'note' : 'notes'}
            </p>
          )}
        </header>

        {error && (
          <p className="notes-empty">These notes are not loading right now. Try again in a moment.</p>
        )}
        {ready && !notes.length && !error && <p className="notes-empty">Nothing is tagged #{tag}.</p>}

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
      </section>
    </>
  )
}
