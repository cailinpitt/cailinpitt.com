import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { LinkCard } from './LinkCard'
import { NoteText } from './NoteText'
import { formatRelative } from '../lib/datetime'
import { fetchNotesNow, notePath, type Note } from '../lib/notes'
import { resolveContext } from '../lib/notesContext'

/**
 * The newest note, for the homepage — counterpart to NowPlayingBar/ReadingBar,
 * same lightweight `/now.json` endpoint. Renders nothing until it has data, so
 * a Worker hiccup leaves the homepage clean. No polling: a note appears
 * because Cailin typed it, not on a timer. Shown in full — at most 480 chars
 * by construction, so there's nothing worth truncating.
 */
export function NotesBar() {
  const [note, setNote] = useState<Note | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchNotesNow(controller.signal)
      .catch(() => null)
      .then((data) => {
        if (data?.latest) setNote(data.latest)
      })
    return () => controller.abort()
  }, [])

  if (!note) return null

  // Same generic-label fallback /notes uses, since the homepage doesn't load photos/activities/posts either — see notesContext.ts.
  const context = resolveContext(note.contextType, note.contextRef)

  return (
    <div className="note-bar">
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
        <a className="note-permalink" href={notePath(note.id)}>
          {formatRelative(note.createdAt)}
        </a>
        {note.editedAt && <span className="note-edited">edited</span>}
      </p>
    </div>
  )
}
