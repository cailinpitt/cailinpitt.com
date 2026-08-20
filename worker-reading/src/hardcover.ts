// Thin hardcover.app client — the library read the daily sync needs, nothing else.
// Returns one normalized row per *read session* (see schema.sql).
//
// Hardcover caps query depth at 3, so authors come from the denormalized
// `books.cached_contributors` jsonb rather than a `contributions` join (that
// table is polymorphic and can't be filtered by book anyway). And `me` returns
// an array, not an object — Hasura convention throughout.

const ENDPOINT = 'https://api.hardcover.app/v1/graphql'

/** Books per page. The API allows more, but this keeps each response small. */
const PAGE_SIZE = 100

/** Hardcover's user_books.status_id values. */
export const STATUS = {
  want: 1,
  reading: 2,
  read: 3,
  paused: 4,
  dnf: 5,
} as const

export interface BookRow {
  userBookId: number
  /** user_book_reads.id, or 0 when the book has no read session recorded. */
  readId: number
  bookId: number
  title: string
  authors: string | null
  slug: string | null
  coverSource: string | null
  pages: number | null
  rating: number | null
  statusId: number
  /** YYYY-MM-DD; Hardcover stores dates, not timestamps. */
  startedAt: string | null
  finishedAt: string | null
}

interface RawRead {
  id: number
  started_at: string | null
  finished_at: string | null
}

interface RawBook {
  title: string | null
  slug: string | null
  pages: number | null
  /** jsonb: `{ url, color, width, height, … }`. Treat the shape as unknown. */
  cached_image: unknown
  /** jsonb: `[{ author: { name, … }, contribution: string | null }, …]`. */
  cached_contributors: unknown
}

interface RawUserBook {
  id: number
  book_id: number
  status_id: number
  rating: number | null
  book: RawBook | null
  user_book_reads: RawRead[] | null
}

interface GraphQLResponse<T> {
  data?: T
  errors?: { message: string }[]
}

const ME_QUERY = `query Me { me { id username } }`

const LIBRARY_QUERY = `
  query Library($userId: Int!, $limit: Int!, $offset: Int!) {
    user_books(
      where: { user_id: { _eq: $userId } }
      order_by: { id: asc }
      limit: $limit
      offset: $offset
    ) {
      id
      book_id
      status_id
      rating
      book {
        title
        slug
        pages
        cached_image
        cached_contributors
      }
      user_book_reads(order_by: { id: asc }) {
        id
        started_at
        finished_at
      }
    }
  }`

async function gql<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      // Hardcover's account page shows the token *with* a "Bearer " prefix, so
      // whether the stored secret includes it is a coin flip. Adding a second
      // one produces a 401 that looks like a bad token.
      authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'cailinpitt.com-reading/1.0 (+https://cailinpitt.com)',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    throw new Error(`Hardcover HTTP ${res.status}: ${await res.text()}`)
  }

  // GraphQL reports most failures in-band with a 200, so the status check above
  // is not enough on its own.
  const body = (await res.json()) as GraphQLResponse<T>
  if (body.errors?.length) {
    throw new Error(`Hardcover GraphQL: ${body.errors.map((e) => e.message).join('; ')}`)
  }
  if (!body.data) throw new Error('Hardcover returned no data')
  return body.data
}

/** A jsonb column can arrive parsed or as a JSON string, depending on the row. */
function asJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function coverUrl(cached: unknown): string | null {
  const value = asJson(cached)
  if (typeof value === 'string') return value.startsWith('http') ? value : null
  if (!value || typeof value !== 'object') return null
  const url = (value as { url?: unknown }).url
  return typeof url === 'string' && url.startsWith('http') ? url : null
}

/**
 * Contributors cover translators, narrators and illustrators too. A null role is
 * the author — that is how Hardcover records the primary credit.
 */
const isAuthorCredit = (role: unknown): boolean =>
  role == null || (typeof role === 'string' && (role.trim() === '' || /^author$/i.test(role.trim())))

function authorsFrom(cached: unknown): string | null {
  const list = asJson(cached)
  if (!Array.isArray(list)) return null

  const authors: string[] = []
  const everyone: string[] = []
  for (const entry of list) {
    const name = (entry as { author?: { name?: unknown } })?.author?.name
    if (typeof name !== 'string' || !name.trim()) continue
    // Hardcover's data has stray double spaces in some names ("Ben  Reeves").
    const clean = name.replace(/\s+/g, ' ').trim()
    if (!everyone.includes(clean)) everyone.push(clean)
    if (isAuthorCredit((entry as { contribution?: unknown })?.contribution)) {
      if (!authors.includes(clean)) authors.push(clean)
    }
  }

  // An audiobook can list only a narrator. Showing that beats showing nothing.
  const names = authors.length ? authors : everyone
  return names.length ? names.join(', ') : null
}

export async function fetchUserId(token: string): Promise<number> {
  const data = await gql<{ me: { id: number; username: string }[] }>(token, ME_QUERY)
  const id = data.me?.[0]?.id
  if (typeof id !== 'number') throw new Error('Hardcover: could not resolve the user id from `me`')
  return id
}

/** Every book in the library, one row per read session. */
export async function fetchLibrary(token: string, userId: number): Promise<BookRow[]> {
  const rows: BookRow[] = []

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const data = await gql<{ user_books: RawUserBook[] }>(token, LIBRARY_QUERY, {
      userId,
      limit: PAGE_SIZE,
      offset,
    })
    const page = data.user_books ?? []

    for (const ub of page) {
      const base = {
        userBookId: ub.id,
        bookId: ub.book_id,
        title: ub.book?.title?.trim() || 'Untitled',
        authors: authorsFrom(ub.book?.cached_contributors),
        slug: ub.book?.slug ?? null,
        coverSource: coverUrl(ub.book?.cached_image),
        pages: ub.book?.pages ?? null,
        rating: ub.rating ?? null,
        statusId: ub.status_id,
      }

      const reads = ub.user_book_reads ?? []
      if (!reads.length) {
        // No session recorded (want-to-read, or read with no dates).
        rows.push({ ...base, readId: 0, startedAt: null, finishedAt: null })
        continue
      }
      for (const read of reads) {
        rows.push({
          ...base,
          readId: read.id,
          startedAt: read.started_at ?? null,
          finishedAt: read.finished_at ?? null,
        })
      }
    }

    if (page.length < PAGE_SIZE) break
  }

  return rows
}
