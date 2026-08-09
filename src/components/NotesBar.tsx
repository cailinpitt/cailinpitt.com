import { useEffect, useState } from 'react'
import { NoteText } from './NoteText'
import { formatRelative } from '../lib/datetime'
import { fetchNotesNow, notePath, type Note } from '../lib/notes'

/**
 * The newest note, for the homepage — the counterpart to NowPlayingBar and
 * ReadingBar, and read from the same kind of lightweight `/now.json` endpoint.
 *
 * Renders nothing until it has data, so the prerendered shell and any Worker
 * hiccup just leave the homepage clean. No polling: unlike now-playing, a note
 * appears because Cailin typed it, and someone sitting on the homepage waiting
 * for one is not a case worth a request every sixty seconds.
 *
 * The note is shown in full rather than clipped. A note is at most 480
 * characters by construction, which is shorter than the paragraph above it —
 * there is nothing to truncate, and truncating would make the strip a teaser for
 * something the reader could already have finished.
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

  return (
    <div className="note-bar">
      <div className="note-body">
        <NoteText text={note.text} />
      </div>
      <p className="note-meta">
        <a className="note-permalink" href={notePath(note.id)}>
          {formatRelative(note.createdAt)}
        </a>
        {note.editedAt && <span className="note-edited">edited</span>}
      </p>
    </div>
  )
}
