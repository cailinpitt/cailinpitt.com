import { newId } from './hash'
import type { CleanComment } from './validate'

export interface Comment {
  id: string
  postPath: string
  name: string
  message: string
  website: string | null
  createdAt: number
}

export interface AdminComment extends Comment {
  ipHash: string
}

export interface CommentPage {
  comments: Comment[]
  nextCursor: string | null
  total: number
}

const COLUMNS = 'id, post_path, name, message, website, created_at'

interface Row {
  id: string
  post_path: string
  name: string
  message: string
  website: string | null
  created_at: number
  ip_hash?: string
}

const toComment = (row: Row): Comment => ({
  id: row.id,
  postPath: row.post_path,
  name: row.name,
  message: row.message,
  website: row.website,
  createdAt: row.created_at,
})

export const PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 50

export async function listComments(
  db: D1Database,
  postPath: string,
  opts: { before?: string | null; limit?: number } = {},
): Promise<CommentPage> {
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const cursor = parseCursor(opts.before)

  const statement = cursor
    ? db
        .prepare(
          `SELECT ${COLUMNS} FROM comments
            WHERE post_path = ?1 AND ((created_at < ?2) OR (created_at = ?2 AND id < ?3))
            ORDER BY created_at DESC, id DESC
            LIMIT ?4`,
        )
        .bind(postPath, cursor.createdAt, cursor.id, limit + 1)
    : db
        .prepare(
          `SELECT ${COLUMNS} FROM comments
            WHERE post_path = ?1
            ORDER BY created_at DESC, id DESC
            LIMIT ?2`,
        )
        .bind(postPath, limit + 1)

  const [{ results }, total] = await Promise.all([
    statement.all<Row>(),
    countForPost(db, postPath),
  ])

  const rows = results ?? []
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]

  return {
    comments: page.map(toComment),
    nextCursor: hasMore && last ? `${last.created_at}.${last.id}` : null,
    total,
  }
}

function parseCursor(raw: string | null | undefined): { createdAt: number; id: string } | null {
  if (!raw) return null
  const dot = raw.indexOf('.')
  if (dot <= 0) return null
  const createdAt = Number(raw.slice(0, dot))
  const id = raw.slice(dot + 1)
  if (!Number.isFinite(createdAt) || !id) return null
  return { createdAt, id }
}

export async function countForPost(db: D1Database, postPath: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE post_path = ?1')
    .bind(postPath)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function insertComment(
  db: D1Database,
  comment: CleanComment,
  meta: { ipHash: string },
): Promise<Comment> {
  const row: Comment = {
    id: newId(),
    ...comment,
    createdAt: Math.floor(Date.now() / 1000),
  }
  await db
    .prepare(
      `INSERT INTO comments (id, post_path, name, message, website, created_at, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(row.id, row.postPath, row.name, row.message, row.website, row.createdAt, meta.ipHash)
    .run()
  return row
}

export async function deleteComment(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM comments WHERE id = ?1').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

export function countByIp(db: D1Database, ipHash: string, since: number): Promise<number> {
  return db
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE ip_hash = ?1 AND created_at > ?2')
    .bind(ipHash, since)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0)
}

export function countSince(db: D1Database, since: number): Promise<number> {
  return db
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE created_at > ?1')
    .bind(since)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0)
}

// Includes ip_hash so the moderation CLI can group comments from one bucket.
export async function listForAdmin(db: D1Database, limit: number): Promise<AdminComment[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS}, ip_hash FROM comments ORDER BY created_at DESC, id DESC LIMIT ?1`,
    )
    .bind(Math.min(Math.max(limit, 1), 200))
    .all<Row>()
  return (results ?? []).map((row) => ({ ...toComment(row), ipHash: row.ip_hash ?? '' }))
}
