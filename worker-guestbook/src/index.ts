// Guestbook API for cailinpitt.com/guestbook.
//
// The first endpoint on this site that accepts writes from the public, which is
// the only thing that makes it interesting. Reads are the same shape as the
// other two workers — one D1 query behind the edge cache, plus a curl view.
// Writes run a layered gauntlet, ordered cheapest-first so an attack is turned
// away before it costs a database query:
//
//   origin → honeypot → Turnstile → validation → per-IP limit → global limit
//
// Entries publish the moment they pass. Moderation is after the fact, through
// the ADMIN_TOKEN routes that `npm run guestbook:list` / `guestbook:rm` drive.

import { ipHash } from './hash'
import {
  countByIp,
  countSince,
  deleteEntry,
  insertEntry,
  listEntries,
  listForAdmin,
  MAX_PAGE_SIZE,
  PAGE_SIZE,
  type Entry,
} from './store'
import { renderText, TEXT_ROWS } from './text'
import { verifyTurnstile } from './turnstile'
import { LIMITS, validate } from './validate'

/** Edge-cache lifetime for the read endpoints. */
const EDGE_TTL = 30

/** Where a browser landing on this Worker gets sent. */
const SITE_GUESTBOOK = 'https://cailinpitt.com/guestbook'

// ---- rate limits ---------------------------------------------------------
//
// Two per-person windows and one for the whole guestbook. The numbers are set
// for how a guestbook is actually used: signing it twice is plausible, signing
// it four times in an hour is not, and nobody legitimate is the eleventh entry
// from one address in a day.

const HOUR = 3600
const DAY = 86_400

const PER_IP_HOURLY = 3
const PER_IP_DAILY = 10

/**
 * The backstop. Per-IP limits do nothing against a botnet, so the guestbook as a
 * whole also refuses to take more than this many entries an hour. It is the
 * reason the daily write volume has a knowable ceiling (~1,440 rows) no matter
 * what happens, which is what keeps a bad day inside D1's free tier.
 *
 * Set high enough that it can only be reached by an attack: an actual burst of
 * human attention — a post doing well somewhere — arrives as tens of entries a
 * day, not sixty an hour.
 */
const GLOBAL_HOURLY = 60

// ---- CORS ----------------------------------------------------------------

// Any loopback port, so a dev server that lands on 5174 instead of 5173 still
// works without editing wrangler.jsonc.
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

// ---- responses -----------------------------------------------------------

// The cached builders deliberately omit CORS: it varies by Origin and is applied
// by withCors() after the cache, so a cached entry stays origin-independent.

function textResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': `public, max-age=${EDGE_TTL}`,
    },
  })
}

function json(body: unknown, maxAge: number): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
    },
  })
}

/** For everything that must never be cached: writes, admin, errors. */
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

// ---- edge cache ----------------------------------------------------------
//
// Cloudflare does not cache Worker-generated responses on its own, so without
// this every reader executes the Worker and its D1 query. Same helper as the
// other two workers.

const cacheKey = (url: URL, variant: string): Request => {
  const key = new URL(url.toString())
  key.searchParams.set('__variant', variant)
  return new Request(key.toString(), { method: 'GET' })
}

function withCors(res: Response, cors: Record<string, string>): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
  return out
}

async function cached(
  url: URL,
  variant: string,
  ctx: ExecutionContext,
  cors: Record<string, string>,
  build: () => Promise<Response>,
): Promise<Response> {
  const key = cacheKey(url, variant)
  const hit = await caches.default.match(key)
  if (hit) return withCors(hit, cors)

  const fresh = await build()
  if (fresh.status === 200) ctx.waitUntil(caches.default.put(key, fresh.clone()))
  return withCors(fresh, cors)
}

// ---- auth ----------------------------------------------------------------

/**
 * Bearer-token check for the moderation routes.
 *
 * Compared in constant time. The reading worker's equivalent doesn't bother and
 * is fine in practice, but this one is worth doing properly: it is the only
 * thing standing between the internet and `DELETE`, and a length-independent
 * comparison costs nothing.
 */
function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (token.length !== secret.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i)
  return diff === 0
}

// ---- curl detection ------------------------------------------------------

const CLI_AGENT = /^(curl|wget|httpie|HTTPie|xh|powershell|fetch)\b/i

function wantsText(request: Request, url: URL): boolean {
  if (url.searchParams.has('format') || url.searchParams.has('json')) return false
  return CLI_AGENT.test(request.headers.get('user-agent') ?? '')
}

// ---- the write path ------------------------------------------------------

interface SignPayload {
  name?: unknown
  message?: unknown
  website?: unknown
  location?: unknown
  /** Turnstile widget token. */
  token?: unknown
  /** Honeypot. A real browser never fills this in — see below. */
  nickname?: unknown
}

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

/**
 * POST /entries.
 *
 * Returns the created row so the client can prepend it immediately: the read
 * endpoint sits behind a 30-second edge cache, so a fresh signer would otherwise
 * refresh and not find themselves.
 */
async function sign(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  // 1. Origin. Not a security boundary on its own — a non-browser client sets
  //    any Origin it likes — but it stops the form being embedded and driven
  //    from someone else's page, and it is free.
  if (!originAllowed(request, env)) {
    return jsonNoStore({ error: 'Not allowed from this origin.' }, 403, cors)
  }

  const payload = (await request.json().catch(() => null)) as SignPayload | null
  if (!payload) return jsonNoStore({ error: 'Expected a JSON body.' }, 400, cors)

  // 2. Honeypot. The form renders a `nickname` field that is hidden from sight
  //    and from screen readers; a person cannot fill it in, and a bot that fills
  //    every input will. The response is a normal-looking success with nothing
  //    written, so the bot records a win and never learns to adapt.
  if (typeof payload.nickname === 'string' && payload.nickname.trim()) {
    log({ level: 'info', rejected: 'honeypot' })
    return jsonNoStore({ ok: true, entry: null }, 200, cors)
  }

  // 3. Turnstile. The one that actually stops an automated loop.
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

  // 4. Validation. Bounds every string before any of it reaches D1.
  const checked = validate(payload)
  if (!checked.ok) {
    return jsonNoStore({ error: checked.error, field: checked.field }, 400, cors)
  }

  // 5 + 6. Rate limits. Both counts are index seeks, and they run together.
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
      { error: "You've signed a few times already — give it a little while." },
      429,
      cors,
    )
  }
  if (global >= GLOBAL_HOURLY) {
    log({ level: 'warn', rejected: 'global-limit', global })
    return jsonNoStore(
      { error: 'The guestbook is taking a breather. Try again in a bit.' },
      503,
      cors,
    )
  }

  const entry = await insertEntry(env.DB, checked.value, {
    // Cloudflare geolocates the connecting IP for us; there is no field to fill
    // in and no lookup to pay for. Absent on `wrangler dev` and for the handful
    // of addresses it can't place, which the page renders as simply no flag.
    country: (request.cf?.country as string | undefined) ?? null,
    ipHash: hash,
  })
  log({ level: 'info', signed: { id: entry.id, country: entry.country } })

  return jsonNoStore({ ok: true, entry }, 201, cors)
}

// ---- worker --------------------------------------------------------------

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    const url = new URL(request.url)
    try {
      if (url.pathname === '/entries' && request.method === 'POST') {
        return await sign(request, env, cors)
      }

      // Moderation. Both routes are ADMIN_TOKEN-only and never cached.
      if (url.pathname === '/admin/entries' && request.method === 'GET') {
        if (!authorized(request, env.ADMIN_TOKEN)) {
          return jsonNoStore({ error: 'Unauthorized' }, 401, cors)
        }
        const limit = Number(url.searchParams.get('limit')) || 50
        return jsonNoStore({ entries: await listForAdmin(env.DB, limit) }, 200, cors)
      }

      const del = url.pathname.match(/^\/entries\/([A-Za-z0-9]+)$/)
      if (del && request.method === 'DELETE') {
        if (!authorized(request, env.ADMIN_TOKEN)) {
          return jsonNoStore({ error: 'Unauthorized' }, 401, cors)
        }
        const id = del[1]
        const removed = await deleteEntry(env.DB, id)
        log({ level: 'info', delete: { id, removed } })
        return removed
          ? jsonNoStore({ id, deleted: true }, 200, cors)
          : jsonNoStore({ id, error: 'no such entry' }, 404, cors)
      }

      // `curl guestbook.cailinpitt.com` → the terminal view. Checked before the
      // redirect below, which is what a browser on the same path gets instead.
      if ((url.pathname === '/' || url.pathname === '/guestbook') && wantsText(request, url)) {
        return cached(url, 'text', ctx, cors, async () =>
          textResponse(
            renderText(await listEntries(env.DB, { limit: TEXT_ROWS }), {
              // ?T disables color, matching wttr.in's convention.
              color: !url.searchParams.has('T'),
              offset: Number(env.TZ_OFFSET_SECONDS) || 0,
            }),
          ),
        )
      }

      if (url.pathname === '/guestbook.json') {
        return cached(url, 'json', ctx, cors, async () =>
          json(
            await listEntries(env.DB, {
              before: url.searchParams.get('before'),
              limit: Number(url.searchParams.get('limit')) || PAGE_SIZE,
            }),
            EDGE_TTL,
          ),
        )
      }

      // The form's own limits, so the client can enforce them without a second
      // copy of the numbers drifting out of sync with validate.ts.
      if (url.pathname === '/limits.json') {
        return cached(url, 'limits', ctx, cors, async () =>
          json({ ...LIMITS, pageSize: PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE }, 86_400),
        )
      }

      // Same paths in a browser: send them to the real page instead of a 404.
      // 302 and no-store, because this response is User-Agent dependent — a
      // cached permanent redirect could later be replayed to a client that
      // wanted the terminal view, which would break `curl` for this URL.
      if (url.pathname === '/' || url.pathname === '/guestbook') {
        return new Response(null, {
          status: 302,
          headers: { location: SITE_GUESTBOOK, 'cache-control': 'no-store', ...cors },
        })
      }

      return new Response('Not found', { status: 404, headers: cors })
    } catch (err) {
      log({ level: 'error', route: url.pathname, error: String(err) })
      return new Response('Internal error', { status: 500, headers: cors })
    }
  },
} satisfies ExportedHandler<Env>

export type { Entry }
