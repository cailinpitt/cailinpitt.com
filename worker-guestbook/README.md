# Guestbook API (Cloudflare Worker)

Backs [`cailinpitt.com/guestbook`](https://cailinpitt.com/guestbook). The only endpoint on this
site that accepts **writes from the public** — what makes it different from the other Workers.

| File | What it does |
|---|---|
| `src/index.ts` | routing, CORS, edge cache, the write gauntlet, admin routes |
| `src/validate.ts` | every rule about what a stranger may type |
| `src/turnstile.ts` | siteverify call — the part that stops automation |
| `src/store.ts` | all D1 access (list, insert, delete, rate-limit counts) |
| `src/text.ts` | the `curl guestbook.cailinpitt.com` view |
| `src/hash.ts` | salted IP hashing + entry ids |
| `schema.sql` | the single `entries` table |

## Endpoints

| Route | Auth | Cache |
|---|---|---|
| `GET /guestbook.json?before=&limit=` | — | edge, 30s |
| `GET /limits.json` | — | edge, 1 day |
| `GET /` (curl user-agent) | — | edge, 30s — text view |
| `GET /` (browser) | — | 302 to the site page |
| `POST /entries` | Turnstile + origin + rate limits | never |
| `GET /admin/entries?limit=` | `Bearer ADMIN_TOKEN` | never |
| `DELETE /entries/:id` | `Bearer ADMIN_TOKEN` | never |

## Setup

```sh
npm install

# 1. Database — paste the printed id into wrangler.jsonc
npx wrangler d1 create cailinpitt-guestbook
npm run schema:remote

# 2. Turnstile widget: dash.cloudflare.com → Turnstile → Add widget.
#    Mode "Managed", hostnames cailinpitt.com and localhost. Put the SITE key
#    in BOTH wrangler.jsonc and src/lib/guestbook.ts, then:
npx wrangler secret put TURNSTILE_SECRET

# 3. Moderation token + IP salt — values are in the repo-root .env as
#    GUESTBOOK_ADMIN_TOKEN and GUESTBOOK_IP_SALT
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put IP_SALT

npm run deploy
```

**Local development:**

```sh
npm run schema:local
npm run dev            # http://localhost:8787
```

`.dev.vars` carries Cloudflare's always-passes Turnstile test keys, so the form works before a
real widget exists. **The local Worker therefore accepts any token** — local testing exercises
validation and rate limits, not Turnstile itself.

Point the site at it with `VITE_GUESTBOOK_API=http://localhost:8787 npm run dev` from the repo
root.

## Design notes

### Instant publish, moderate after

Entries go live the moment they pass — no pending state, no approval queue; deleting is immediate
and permanent. The trade: signing a guestbook should feel like signing a guestbook, and the
defenses below make it affordable to skip the queue.

Moderation is `npm run guestbook:list` / `npm run guestbook:rm -- <id>` from the repo root
(`scripts/guestbook.mjs`). The admin listing includes each entry's IP hash and flags repeats,
since ten entries under ten names from one hash is the shape a flood actually has — invisible on
the public page.

### The write gauntlet

Ordered cheapest-first, so an attack is turned away before it costs a query:

| # | Check | Rejects |
|---|---|---|
| 1 | Origin against `ALLOWED_ORIGIN` (+ loopback) | the form driven from another page |
| 2 | Honeypot `nickname` field | anything filling every input in the DOM |
| 3 | Turnstile siteverify | automation, which is the actual threat |
| 4 | `validate.ts` — lengths, link cap, URL scheme | junk and payload attempts |
| 5 | Per-IP: 3/hour, 10/day | one person flooding |
| 6 | Global: 60/hour | a botnet, and the D1 bill |

Only 5 and 6 touch the database, both index seeks over `(ip_hash, created_at)`.

**Turnstile is load-bearing.** Everything else raises the cost of an attack; Turnstile makes a
submission loop not work at all — the token is single-use and short-lived, so a captured request
body can't be replayed. It fails **closed**: an outage makes the guestbook briefly read-only
rather than briefly open. The read path never calls it.

**The honeypot returns a fake success.** A bot filling the hidden field gets
`200 {"ok":true,"entry":null}` and nothing is written — telling it the truth would teach it to
skip the field.

**The global limit is the cost ceiling.** Per-IP limits do nothing against a distributed attack,
so the guestbook refuses more than `GLOBAL_HOURLY` (60) entries an hour — worst case ~1,440
rows/day against D1's 100,000 free writes. Real human attention arrives as tens of entries a day.

### IP addresses are never stored

`ip_hash` is `SHA-256(IP + IP_SALT)` truncated to 128 bits, salt as a Worker secret, so it can't
be reversed by hashing the IPv4 space the way an unsalted hash could. Never returned by a public
endpoint; exists only to answer "how many entries has this bucket posted lately."

**`IP_SALT` must stay stable.** Rotating it silently resets everyone's rate-limit window, since
existing rows no longer hash to anything a new request matches.

### Escaping happens on output, not input

Stored text is exactly what someone typed, minus control and format characters. The page renders
entries as React text nodes, never as markup, so a stored `<script>` is eleven visible characters.

Escaping matters in the terminal too: `src/text.ts` strips control characters before printing,
since a raw byte stream could carry ANSI sequences that repaint a reader's screen.
`scripts/guestbook.mjs` does the same.

Links carry `rel="nofollow ugc noopener noreferrer"`, removing the reason to spam a guestbook.

### No KV, no cron

A few hundred short rows. One indexed query behind a 30-second edge cache is cheaper than any
precomputed blob, and nothing here runs on a schedule.
