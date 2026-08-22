// Write path: origin -> honeypot -> Turnstile -> validation -> per-IP limit -> global limit.
// Comments publish immediately; moderate after the fact via comments:list / comments:rm.

import { ipHash } from './hash'
import {
  countByIp,
  countSince,
  deleteComment,
  insertComment,
  listComments,
  listForAdmin,
  PAGE_SIZE,
  type Comment,
} from './store'
import { verifyTurnstile } from './turnstile'
import { validate } from './validate'

const EDGE_TTL = 30

const HOUR = 3600
const DAY = 86_400

const PER_IP_HOURLY = 3
const PER_IP_DAILY = 10
// Backstop against a botnet, which per-IP limits alone can't catch.
const GLOBAL_HOURLY = 60

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

const allowedOrigins = (env: Env) => env.ALLOWED_ORIGIN.split(',').map((o) => o.trim())

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('origin') ?? ''
  return allowedOrigins(env).includes(origin) || LOOPBACK.test(origin)
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin') ?? ''
  return {
    'access-control-allow-origin': originAllowed(request, env) ? origin : allowedOrigins(env)[0],
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    vary: 'origin',
  }
}

function json(body: unknown, maxAge: number): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
    },
  })
}

function jsonNoStore(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cors,
    },
  })
}

const cacheKey = (url: URL): Request => new Request(url.toString(), { method: 'GET' })

function withCors(res: Response, cors: Record<string, string>): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
  return out
}

async function cached(
  url: URL,
  ctx: ExecutionContext,
  cors: Record<string, string>,
  build: () => Promise<Response>,
): Promise<Response> {
  const key = cacheKey(url)
  const hit = await caches.default.match(key)
  if (hit) return withCors(hit, cors)

  const fresh = await build()
  if (fresh.status === 200) ctx.waitUntil(caches.default.put(key, fresh.clone()))
  return withCors(fresh, cors)
}

function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (token.length !== secret.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i)
  return diff === 0
}

interface PostPayload {
  postPath?: unknown
  name?: unknown
  message?: unknown
  website?: unknown
  token?: unknown
  nickname?: unknown
}

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

async function post(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (!originAllowed(request, env)) {
    return jsonNoStore({ error: 'Not allowed from this origin.' }, 403, cors)
  }

  const payload = (await request.json().catch(() => null)) as PostPayload | null
  if (!payload) return jsonNoStore({ error: 'Expected a JSON body.' }, 400, cors)

  // Fake success so the bot never learns to skip the field.
  if (typeof payload.nickname === 'string' && payload.nickname.trim()) {
    log({ level: 'info', rejected: 'honeypot' })
    return jsonNoStore({ ok: true, comment: null }, 200, cors)
  }

  const verdict = await verifyTurnstile(
    payload.token,
    env.TURNSTILE_SECRET,
    request.headers.get('cf-connecting-ip'),
  )
  if (!verdict.ok) {
    log({ level: 'info', rejected: 'turnstile', codes: verdict.codes })
    return jsonNoStore(
      { error: "That challenge didn't check out. Reload the page and try again." },
      403,
      cors,
    )
  }

  const checked = validate(payload)
  if (!checked.ok) {
    return jsonNoStore({ error: checked.error, field: checked.field }, 400, cors)
  }

  const now = Math.floor(Date.now() / 1000)
  const hash = await ipHash(request, env.IP_SALT)
  const [hourly, daily, global] = await Promise.all([
    countByIp(env.DB, hash, now - HOUR),
    countByIp(env.DB, hash, now - DAY),
    countSince(env.DB, now - HOUR),
  ])

  if (hourly >= PER_IP_HOURLY || daily >= PER_IP_DAILY) {
    log({ level: 'info', rejected: 'rate-limit', hourly, daily })
    return jsonNoStore(
      { error: "You've commented a few times already — give it a little while." },
      429,
      cors,
    )
  }
  if (global >= GLOBAL_HOURLY) {
    log({ level: 'warn', rejected: 'global-limit', global })
    return jsonNoStore(
      { error: 'Comments are taking a breather right now. Try again in a bit.' },
      503,
      cors,
    )
  }

  const comment = await insertComment(env.DB, checked.value, { ipHash: hash })
  log({ level: 'info', posted: { id: comment.id, postPath: comment.postPath } })

  return jsonNoStore({ ok: true, comment }, 201, cors)
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    const url = new URL(request.url)
    try {
      if (url.pathname === '/comments' && request.method === 'POST') {
        return await post(request, env, cors)
      }

      if (url.pathname === '/admin/comments' && request.method === 'GET') {
        if (!authorized(request, env.ADMIN_TOKEN)) {
          return jsonNoStore({ error: 'Unauthorized' }, 401, cors)
        }
        const limit = Number(url.searchParams.get('limit')) || 50
        return jsonNoStore({ comments: await listForAdmin(env.DB, limit) }, 200, cors)
      }

      const del = url.pathname.match(/^\/comments\/([A-Za-z0-9]+)$/)
      if (del && request.method === 'DELETE') {
        if (!authorized(request, env.ADMIN_TOKEN)) {
          return jsonNoStore({ error: 'Unauthorized' }, 401, cors)
        }
        const id = del[1]
        const removed = await deleteComment(env.DB, id)
        log({ level: 'info', delete: { id, removed } })
        return removed
          ? jsonNoStore({ id, deleted: true }, 200, cors)
          : jsonNoStore({ id, error: 'no such comment' }, 404, cors)
      }

      if (url.pathname === '/comments.json') {
        const postPath = url.searchParams.get('post')
        if (!postPath) {
          return jsonNoStore({ error: 'Missing ?post=' }, 400, cors)
        }
        return cached(url, ctx, cors, async () =>
          json(
            await listComments(env.DB, postPath, {
              before: url.searchParams.get('before'),
              limit: Number(url.searchParams.get('limit')) || PAGE_SIZE,
            }),
            EDGE_TTL,
          ),
        )
      }

      return new Response('Not found', { status: 404, headers: cors })
    } catch (err) {
      log({ level: 'error', route: url.pathname, error: String(err) })
      return new Response('Internal error', { status: 500, headers: cors })
    }
  },
} satisfies ExportedHandler<Env>

export type { Comment }
