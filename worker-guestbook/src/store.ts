// D1 access. Every query in the guestbook lives here.
//
// The whole read path is one indexed query per request, behind an edge cache, so
// there are no precomputed blobs and no KV namespace — see the note in
// wrangler.jsonc. The write path adds two COUNT(*)s for the rate limits, both of
// which are index seeks rather than scans.

import { newId } from './hash'
import type { CleanEntry } from './validate'

export interface Entry {
  id: string
  name: string
  message: string
  website: string | null
  location: string | null
  /** ISO-3166-1 alpha-2, or null when Cloudflare couldn't say. */
  country: string | null
  /** Unix seconds. */
  createdAt: number
}

/** What the moderation CLI sees. Same row plus the bucket key, for spotting floods. */
export interface AdminEntry extends Entry {
  ipHash: string
}

export interface EntryPage {
  entries: Entry[]
  /**
   * Opaque; pass straight back as `before`. Null means there are no older
   * entries. It is a `created_at` value, so two entries in the same second at
   * the page boundary could in principle straddle it — see listEntries().
   */
  nextCursor: string | null
  /** Total entries, for the "N people have signed" line. */
  total: number
}

/** Public columns, in a fixed order. `ip_hash` is deliberately absent. */
const COLUMNS = 'id, name, message, website, location, country, created_at'

interface Row {
  id: string
  name: string
  message: string
  website: string | null
  location: string | null
  country: string | null
  created_at: number
  ip_hash?: string
}

const toEntry = (row: Row): Entry => ({
  id: row.id,
  name: row.name,
  message: row.message,
  website: row.website,
  location: row.location,
  country: row.country,
  createdAt: row.created_at,
})

/** Default and maximum page sizes for the public list. */
export const PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 50

/**
 * One page of entries, newest first.
 *
 * Ordering is `created_at DESC, id DESC` and the cursor carries both halves, so
 * entries sharing a second (two people signing at once, or a seeded import) can
 * never be skipped or repeated across a page boundary the way a bare timestamp
 * cursor would allow. `id` is random, which makes it an arbitrary but stable
 * tiebreak — exactly what a cursor needs.
 */
export async function listEntries(
  db: D1Database,
  opts: { before?: string | null; limit?: number } = {},
): Promise<EntryPage> {
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const cursor = parseCursor(opts.before)

  // limit + 1: the extra row answers "is there another page?" without a second
  // query, and is dropped before the response is built.
  const statement = cursor
    ? db
        .prepare(
          `SELECT ${COLUMNS} FROM entries
            WHERE (created_at < ?1) OR (created_at = ?1 AND id < ?2)
            ORDER BY created_at DESC, id DESC
            LIMIT ?3`,
        )
        .bind(cursor.createdAt, cursor.id, limit + 1)
    : db
        .prepare(
          `SELECT ${COLUMNS} FROM entries ORDER BY created_at DESC, id DESC LIMIT ?1`,
        )
        .bind(limit + 1)

  const [{ results }, total] = await Promise.all([
    statement.all<Row>(),
    // COUNT(*) over a few hundred rows is trivial, and it rides on the same
    // cached response as the page, so it costs nothing per reader.
    countEntries(db),
  ])

  const rows = results ?? []
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]

  return {
    entries: page.map(toEntry),
    nextCursor: hasMore && last ? `${last.created_at}.${last.id}` : null,
    total,
  }
}

/** `<created_at>.<id>`. Anything malformed is treated as no cursor at all. */
function parseCursor(raw: string | null | undefined): { createdAt: number; id: string } | null {
  if (!raw) return null
  const dot = raw.indexOf('.')
  if (dot <= 0) return null
  const createdAt = Number(raw.slice(0, dot))
  const id = raw.slice(dot + 1)
  if (!Number.isFinite(createdAt) || !id) return null
  return { createdAt, id }
}

export async function countEntries(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM entries').first<{ n: number }>()
  return row?.n ?? 0
}

export async function insertEntry(
  db: D1Database,
  entry: CleanEntry,
  meta: { country: string | null; ipHash: string },
): Promise<Entry> {
  const row: Entry = {
    id: newId(),
    ...entry,
    country: meta.country,
    createdAt: Math.floor(Date.now() / 1000),
  }
  await db
    .prepare(
      `INSERT INTO entries (id, name, message, website, location, country, created_at, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      row.id,
      row.name,
      row.message,
      row.website,
      row.location,
      row.country,
      row.createdAt,
      meta.ipHash,
    )
    .run()
  return row
}

export async function deleteEntry(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM entries WHERE id = ?1').bind(id).run()
  // D1 reports 0 changes for an id that was never there, which is what lets the
  // route answer 404 instead of pretending it deleted something.
  return (result.meta.changes ?? 0) > 0
}

/** Entries this IP bucket has posted since `since` (unix seconds). */
export function countByIp(db: D1Database, ipHash: string, since: number): Promise<number> {
  return db
    .prepare('SELECT COUNT(*) AS n FROM entries WHERE ip_hash = ?1 AND created_at > ?2')
    .bind(ipHash, since)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0)
}

/** Entries from everyone since `since` — the global circuit breaker's input. */
export function countSince(db: D1Database, since: number): Promise<number> {
  return db
    .prepare('SELECT COUNT(*) AS n FROM entries WHERE created_at > ?1')
    .bind(since)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0)
}

/**
 * Newest entries with their IP bucket attached — the moderation view.
 *
 * Only ever reached behind the ADMIN_TOKEN. The hash is included because it is
 * what makes a flood legible: ten entries under ten names and one hash is one
 * person, and the CLI can group on it.
 */
export async function listForAdmin(db: D1Database, limit: number): Promise<AdminEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS}, ip_hash FROM entries ORDER BY created_at DESC, id DESC LIMIT ?1`,
    )
    .bind(Math.min(Math.max(limit, 1), 200))
    .all<Row>()
  return (results ?? []).map((row) => ({ ...toEntry(row), ipHash: row.ip_hash ?? '' }))
}
