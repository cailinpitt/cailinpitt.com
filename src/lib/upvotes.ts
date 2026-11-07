import { API_BASE } from './comments'

export interface UpvoteResult {
  count: number
  alreadyUpvoted: boolean
}

export async function fetchUpvotes(postPath: string, signal?: AbortSignal): Promise<number> {
  const res = await fetch(`${API_BASE}/upvotes.json?post=${encodeURIComponent(postPath)}`, {
    signal,
  })
  if (!res.ok) throw new Error(`Upvotes API ${res.status}`)
  return ((await res.json()) as { count: number }).count
}

export async function postUpvote(postPath: string, token: string): Promise<UpvoteResult> {
  const res = await fetch(`${API_BASE}/upvotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ postPath, token }),
  })
  const data = (await res.json().catch(() => null)) as
    | (Partial<UpvoteResult> & { error?: string })
    | null
  if (!res.ok || typeof data?.count !== 'number') {
    throw new Error(data?.error ?? 'Something went wrong. Try again in a moment.')
  }
  return { count: data.count, alreadyUpvoted: data.alreadyUpvoted === true }
}

// Only drives the button's pressed state; the server is what enforces one per person.
const storageKey = (postPath: string) => `upvoted:${postPath}`

export function rememberedUpvote(postPath: string): boolean {
  try {
    return localStorage.getItem(storageKey(postPath)) === '1'
  } catch {
    return false
  }
}

export function rememberUpvote(postPath: string): void {
  try {
    localStorage.setItem(storageKey(postPath), '1')
  } catch {
    /* storage unavailable */
  }
}
