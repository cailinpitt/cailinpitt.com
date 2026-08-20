// D1 access. Every query the notes Worker runs lives here. One indexed query
// per read behind the edge cache, no precomputed blobs or KV — same reason as
// the guestbook: a few hundred rows, so an indexed SELECT is cheaper than
// anything that would need to be kept in step with it.

// ContextType/NoteContext live in validate.ts, not here — see the comment
// there on why the import runs in this direction.
import type { ContextType, NoteContext, LinkFields } from './validate'
import { hashtagsIn } from './hashtags'
export type { ContextType, NoteContext, LinkFields }

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
  /** The link a card is attached to, if any. */
  linkUrl: string | null
  /** Whether linkUrl's own text was deleted from `text` when it was set. */
  linkHidden: boolean
  /** Filled in asynchronously — null until the link-card job completes. */
  linkTitle: string | null
  linkDescription: string | null
  /** Whether `og/links/<id>.jpg` exists in R2 yet. */
  linkImageReady: boolean
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

// Short since it's a permalink someone might paste (/notes#a3f91c2b40d1);
// random rather than sequential so an id can't reveal how many notes have ever
// existed, deleted typos included. 48 bits is far past collision range here.
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
  link_url: string | null
  link_hidden: number
  link_title: string | null
  link_description: string | null
  link_image_ready: number
}

const toNote = (row: Row): Note => ({
  id: row.id,
  text: row.text,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  contextType: (row.context_type as ContextType | null) ?? null,
  contextRef: row.context_ref,
  linkUrl: row.link_url,
  linkHidden: row.link_hidden === 1,
  linkTitle: row.link_title,
  linkDescription: row.link_description,
  linkImageReady: row.link_image_ready === 1,
})

/** The column list every SELECT below shares, so a field added here can't be forgotten in one of them. */
const COLUMNS =
  'id, text, created_at, edited_at, context_type, context_ref, link_url, link_hidden, link_title, link_description, link_image_ready'

// Not a bare timestamp like the guestbook uses: two notes in the same second
// (a Shortcut firing twice on a flaky connection) is a real occurrence, and a
// bare-timestamp cursor would skip or loop on the second one. The id breaks the tie.
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

// LIKE prefilters cheaply before the real check, hashtagsIn() (hashtags.ts) —
// without it, searching "tag" would also match a note whose only hashtag is
// "tagging" since SQL LIKE has no word-boundary concept. Bounded at
// MAX_TAG_SCAN rather than the whole table; still cheap at this table's size.
const MAX_TAG_SCAN = 2000

export async function listNotesByTag(
  db: D1Database,
  tag: string,
  opts: { before?: string | null; limit?: number } = {},
): Promise<NotePage> {
  const limit = Math.min(Math.max(1, opts.limit || PAGE_SIZE), MAX_PAGE_SIZE)
  const cursor = decodeCursor(opts.before)

  const query = cursor
    ? db
        .prepare(
          `SELECT ${COLUMNS} FROM notes
           WHERE text LIKE '%#' || ?1 || '%'
             AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
           ORDER BY created_at DESC, id DESC LIMIT ?4`,
        )
        .bind(tag, cursor.uts, cursor.id, MAX_TAG_SCAN)
    : db
        .prepare(
          `SELECT ${COLUMNS} FROM notes
           WHERE text LIKE '%#' || ?1 || '%'
           ORDER BY created_at DESC, id DESC LIMIT ?2`,
        )
        .bind(tag, MAX_TAG_SCAN)

  const { results } = await query.all<Row>()
  const matches = (results ?? []).map(toNote).filter((note) => hashtagsIn(note.text).has(tag))
  const notes = matches.slice(0, limit)

  return {
    notes,
    nextCursor: matches.length > limit && notes.length ? encodeCursor(notes[notes.length - 1]) : null,
    // The exact total would mean scanning past MAX_TAG_SCAN too — not worth
    // it for a filtered view nothing currently reads `total` from.
    total: matches.length,
  }
}

export interface HashtagSummary {
  tag: string
  count: number
}

// Full scan of just `text`, not the LIKE-prefiltered approach listNotesByTag
// uses — no single tag to filter toward. Cached and purged like /notes.json
// rather than kept as a running counter, which would need decrementing on
// every delete/edit and would quietly drift.
export async function listAllHashtags(db: D1Database): Promise<HashtagSummary[]> {
  const { results } = await db.prepare('SELECT text FROM notes').all<{ text: string }>()
  const counts = new Map<string, number>()
  for (const { text } of results ?? []) {
    for (const tag of hashtagsIn(text)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
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
  link: LinkFields | null = null,
): Promise<Note> {
  const note: Note = {
    id: newId(),
    text,
    createdAt: Math.floor(Date.now() / 1000),
    editedAt: null,
    contextType: context?.type ?? null,
    contextRef: context?.ref ?? null,
    linkUrl: link?.url ?? null,
    linkHidden: link?.hidden ?? false,
    linkTitle: null,
    linkDescription: null,
    linkImageReady: false,
  }
  await db
    .prepare(
      `INSERT INTO notes (id, text, created_at, edited_at, context_type, context_ref, link_url, link_hidden)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .bind(
      note.id,
      note.text,
      note.createdAt,
      note.contextType,
      note.contextRef,
      note.linkUrl,
      note.linkHidden ? 1 : 0,
    )
    .run()
  return note
}

// Stamp is not optional or suppressible — the site shows an "edited" marker
// from it, since silently changing a published note's text is the one thing a
// permalink shouldn't do.
export async function updateNote(
  db: D1Database,
  id: string,
  text: string,
  context: NoteContext | null = null,
  link: LinkFields | null = null,
): Promise<Note | null> {
  const editedAt = Math.floor(Date.now() / 1000)
  // Reset even when link_url is unchanged: an edit re-dispatches the link-card
  // job unconditionally, and a stale title left until it finishes would show
  // text that no longer matches what was just typed.
  const { meta } = await db
    .prepare(
      `UPDATE notes SET
         text = ?, edited_at = ?, context_type = ?, context_ref = ?,
         link_url = ?, link_hidden = ?, link_title = NULL, link_description = NULL, link_image_ready = 0
       WHERE id = ?`,
    )
    .bind(
      text,
      editedAt,
      context?.type ?? null,
      context?.ref ?? null,
      link?.url ?? null,
      link?.hidden ? 1 : 0,
      id,
    )
    .run()
  if (!meta.changes) return null
  return getNote(db, id)
}

// Doesn't touch `edited_at` — this isn't an edit to what the note says, only
// to the card attached alongside it.
export async function setLinkCard(
  db: D1Database,
  id: string,
  card: { title: string | null; description: string | null; imageReady: boolean },
): Promise<Note | null> {
  const { meta } = await db
    .prepare('UPDATE notes SET link_title = ?, link_description = ?, link_image_ready = ? WHERE id = ?')
    .bind(card.title, card.description, card.imageReady ? 1 : 0, id)
    .run()
  if (!meta.changes) return null
  return getNote(db, id)
}

/** Immediate and permanent, like `guestbook:rm`. False when there was no such note. */
export async function deleteNote(db: D1Database, id: string): Promise<boolean> {
  const { meta } = await db.prepare('DELETE FROM notes WHERE id = ?').bind(id).run()
  return meta.changes > 0
}
