// Client for the comments API (worker-comments), mirrors lib/guestbook.ts.

const API_BASE = import.meta.env.VITE_COMMENTS_API ?? 'https://comments.cailinpitt.com'

// Same Turnstile widget as the guestbook form. Kept in sync by hand with
// worker-comments/wrangler.jsonc.
export const TURNSTILE_SITE_KEY =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '0x4AAAAAAEEBNcQ83mO9Fcud'

export const LIMITS = {
  name: 60,
  message: 1000,
  website: 200,
} as const

export interface Comment {
  id: string
  postPath: string
  name: string
  message: string
  website: string | null
  createdAt: number
}

export interface CommentPage {
  comments: Comment[]
  nextCursor: string | null
  total: number
}

export interface PostPayload {
  postPath: string
  name: string
  message: string
  website: string
  token: string
  nickname: string
}

export class CommentError extends Error {
  readonly field?: keyof typeof LIMITS
  readonly status: number
  constructor(message: string, status: number, field?: keyof typeof LIMITS) {
    super(message)
    this.name = 'CommentError'
    this.status = status
    this.field = field
  }
}

export async function fetchComments(postPath: string, signal?: AbortSignal): Promise<CommentPage> {
  const res = await fetch(`${API_BASE}/comments.json?post=${encodeURIComponent(postPath)}`, {
    signal,
  })
  if (!res.ok) throw new Error(`Comments API ${res.status}`)
  return res.json() as Promise<CommentPage>
}

export async function fetchOlderComments(
  postPath: string,
  cursor: string,
  limit = 25,
  signal?: AbortSignal,
): Promise<CommentPage> {
  const res = await fetch(
    `${API_BASE}/comments.json?post=${encodeURIComponent(postPath)}` +
      `&before=${encodeURIComponent(cursor)}&limit=${limit}`,
    { signal },
  )
  if (!res.ok) throw new Error(`Comments API ${res.status}`)
  return res.json() as Promise<CommentPage>
}

// Resolves to null when the honeypot caught it — the form treats both as success.
export async function postComment(payload: PostPayload): Promise<Comment | null> {
  const res = await fetch(`${API_BASE}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; comment?: Comment | null; error?: string; field?: keyof typeof LIMITS }
    | null

  if (!res.ok) {
    throw new CommentError(
      data?.error ?? 'Something went wrong. Try again in a moment.',
      res.status,
      data?.field,
    )
  }
  return data?.comment ?? null
}

export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
