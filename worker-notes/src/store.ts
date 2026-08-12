// D1 access. Every query the notes Worker runs lives here.
//
// One indexed query per read, behind the edge cache — no precomputed blobs and
// no KV, for the same reason the guestbook has none: this is a few hundred short
// rows and a `SELECT … ORDER BY created_at DESC LIMIT 25` over an index is
// cheaper than anything that would have to be kept in step with it.

// ContextType/NoteContext live in validate.ts, not here — see the comment
// there on why the import runs in this direction.
import type { ContextType, NoteContext } from './validate'
export type { ContextType, NoteContext }

export interface Note {
  id: string
  text: string
  /** Unix seconds (UTC). */
  createdAt: number
  /** Unix seconds of the last edit, or null if it has never been edited. */
  editedAt: number | null
  /** What this note is about, if anything. Always paired with contextRef. */
  contextType: ContextType | null
  /** The referenced thing's own id (a photo id, an activity id, a post path). */
  contextRef: string | null
}

export interface NotePage {
  notes: Note[]
  /** Opaque; pass straight back as `before`. Null means there are no more. */
  nextCursor: string | null
  total: number
}

/** Notes per page, for the site and the API alike. */
export const PAGE_SIZE = 25

/** Ceiling on `?limit=`. */
export const MAX_PAGE_SIZE = 100

/**
 * A short, opaque id — 6 random bytes as hex.
 *
 * Short because it is a permalink a person might read out or paste into a
 * message (`/notes#a3f91c2b40d1`), and random rather than sequential because an
 * incrementing id would publish how many notes have ever been written, including
 * the ones deleted for being typos. 48 bits is far past collision range for a
 * feed one person writes by hand.
 */
export function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(6))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

interface Row {
  id: string
  text: string
  created_at: number
  edited_at: number | null
  context_type: string | null
  context_ref: string | null
}

const toNote = (row: Row): Note => ({
  id: row.id,
  text: row.text,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  contextType: (row.context_type as ContextType | null) ?? null,
  contextRef: row.context_ref,
})

/** The column list every SELECT below shares, so a field added here can't be forgotten in one of them. */
const COLUMNS = 'id, text, created_at, edited_at, context_type, context_ref'

/**
 * The pagination cursor: `<created_at>_<id>`.
 *
 * Not a bare timestamp, which is what the guestbook uses. Two guestbook
 * signatures in the same second means two different people happened to click at
 * once and is vanishingly rare; two *notes* in the same second is one Shortcut
 * firing twice on a flaky connection, which is a thing that actually happens. A
 * bare-timestamp cursor would then either skip the second note or loop on it
 * forever, so the id breaks the tie and the sort carries it.
 */
const encodeCursor = (note: Note): string => `${note.createdAt}_${note.id}`

const decodeCursor = (raw: string | null | undefined): { uts: number; id: string } | null => {
  const match = raw?.match(/^(\d+)_([a-f0-9]+)$/)
  return match ? { uts: Number(match[1]), id: match[2] } : null
}

export async function listNotes(
  db: D1Database,
  opts: { before?: string | null; limit?: number } = {},
): Promise<NotePage> {
  const limit = Math.min(Math.max(1, opts.limit || PAGE_SIZE), MAX_PAGE_SIZE)
  const cursor = decodeCursor(opts.before)

  // One extra row, so "is there another page" is answered without a second
  // query and without COUNT(*) over the tail.
  const query = cursor
    ? db
        .prepare(
          `SELECT ${COLUMNS} FROM notes
           WHERE created_at < ?1 OR (created_at = ?1 AND id < ?2)
           ORDER BY created_at DESC, id DESC LIMIT ?3`,
        )
        .bind(cursor.uts, cursor.id, limit + 1)
    : db
        .prepare(
          `SELECT ${COLUMNS} FROM notes
           ORDER BY created_at DESC, id DESC LIMIT ?1`,
        )
        .bind(limit + 1)

  const [{ results }, total] = await Promise.all([query.all<Row>(), countNotes(db)])
  const rows = (results ?? []).map(toNote)
  const notes = rows.slice(0, limit)

  return {
    notes,
    nextCursor: rows.length > limit && notes.length ? encodeCursor(notes[notes.length - 1]) : null,
    total,
  }
}

export async function getNote(db: D1Database, id: string): Promise<Note | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM notes WHERE id = ?`)
    .bind(id)
    .first<Row>()
  return row ? toNote(row) : null
}

export async function countNotes(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM notes').first<{ n: number }>()
  return row?.n ?? 0
}

export async function insertNote(
  db: D1Database,
  text: string,
  context: NoteContext | null = null,
): Promise<Note> {
  const note: Note = {
    id: newId(),
    text,
    createdAt: Math.floor(Date.now() / 1000),
    editedAt: null,
    contextType: context?.type ?? null,
    contextRef: context?.ref ?? null,
  }
  await db
    .prepare(
      'INSERT INTO notes (id, text, created_at, edited_at, context_type, context_ref) VALUES (?, ?, ?, NULL, ?, ?)',
    )
    .bind(note.id, note.text, note.createdAt, note.contextType, note.contextRef)
    .run()
  return note
}

/**
 * Rewrite a note's text, stamping `edited_at`.
 *
 * The stamp is not optional and not suppressible: the site shows an "edited"
 * marker from it, because silently changing what a published thing says is the
 * one thing a permalink shouldn't do. Returns null when there is no such note.
 */
export async function updateNote(
  db: D1Database,
  id: string,
  text: string,
  context: NoteContext | null = null,
): Promise<Note | null> {
  const editedAt = Math.floor(Date.now() / 1000)
  const { meta } = await db
    .prepare('UPDATE notes SET text = ?, edited_at = ?, context_type = ?, context_ref = ? WHERE id = ?')
    .bind(text, editedAt, context?.type ?? null, context?.ref ?? null, id)
    .run()
  if (!meta.changes) return null
  return getNote(db, id)
}

/** Immediate and permanent, like `guestbook:rm`. False when there was no such note. */
export async function deleteNote(db: D1Database, id: string): Promise<boolean> {
  const { meta } = await db.prepare('DELETE FROM notes WHERE id = ?').bind(id).run()
  return meta.changes > 0
}
