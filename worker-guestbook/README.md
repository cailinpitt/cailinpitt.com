# Guestbook API (Cloudflare Worker)

Backs [`cailinpitt.com/guestbook`](https://cailinpitt.com/guestbook). The only
endpoint on this site that accepts **writes from the public**, which is the only
thing that makes it different from the other two Workers.

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

## Design notes

### Instant publish, moderate after

Entries go live the moment they pass. There is no pending state, no approval
queue, and no trash — deleting is immediate and permanent. That is the trade:
signing a guestbook should feel like signing a guestbook, and the defenses below
are what make it affordable to skip the queue.

Moderation is `npm run guestbook:list` / `npm run guestbook:rm -- <id>` from the
repo root (see `scripts/guestbook.mjs`). The admin listing includes each entry's
IP hash and flags repeats, because ten entries under ten names from one hash is
the shape a flood actually has, and that is invisible on the public page.

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

Only 5 and 6 touch the database, and both are index seeks over
`(ip_hash, created_at)` rather than scans.

**Turnstile is the load-bearing one.** Everything else raises the cost of an
attack; Turnstile is what makes a submission loop not work at all, because the
token is single-use and short-lived so a captured request body can't be replayed.
It fails **closed** — a Turnstile outage makes the guestbook briefly read-only
rather than briefly open. The read path never calls it, so an outage can't affect
anyone who is only reading.

**The honeypot returns a fake success.** A bot that fills the hidden field gets
`200 {"ok":true,"entry":null}` and nothing is written. Telling it the truth would
only teach it to skip the field next time.

### The global limit is the cost ceiling

Per-IP limits do nothing against a distributed attack, so the guestbook as a
whole refuses more than `GLOBAL_HOURLY` (60) entries an hour. That is what makes
the worst case a *knowable* number — ~1,440 rows a day against D1's free tier of
100,000 writes — instead of an open-ended one. A real burst of human attention
arrives as tens of entries a day, nowhere near it.

### IP addresses are never stored

`ip_hash` is `SHA-256(IP + IP_SALT)`, truncated to 128 bits, and the salt is a
Worker secret — so the stored value can't be reversed by hashing the IPv4 space
the way an unsalted hash could. It is never returned by a public endpoint and
exists only to answer "how many entries has this bucket posted lately."

`IP_SALT` must stay **stable**. Rotating it silently resets everyone's rate-limit
window, because existing rows no longer hash to anything a new request matches.

### Escaping happens on output, not input

Stored text is exactly what someone typed (minus control and format characters,
which are only ever obfuscation). The page renders entries as React text nodes
and never as markup, so a stored `<script>` is eleven visible characters.

The one place escaping genuinely matters is the terminal: `src/text.ts` strips
control characters before printing, because a raw byte stream is how a message
could carry ANSI sequences that repaint a reader's screen. `scripts/guestbook.mjs`
does the same for the same reason.

Links rendered on the page carry `rel="nofollow ugc noopener noreferrer"`, which
removes the reason to spam a guestbook in the first place.

### No KV, no cron

A few hundred short rows. One indexed query behind a 30-second edge cache is
cheaper than any precomputed blob, and nothing here is pulled from anywhere on a
schedule.

## Setup

```sh
cd worker-guestbook
npm install

# 1. Database — paste the printed id into wrangler.jsonc
npx wrangler d1 create cailinpitt-guestbook
npm run schema:remote

# 2. Turnstile widget: dash.cloudflare.com → Turnstile → Add widget
#    Mode "Managed", hostnames `cailinpitt.com` and `localhost`.
#    Put the SITE key in wrangler.jsonc (TURNSTILE_SITE_KEY) and in
#    src/lib/guestbook.ts (TURNSTILE_SITE_KEY). Then:
npx wrangler secret put TURNSTILE_SECRET

# 3. Moderation token + IP salt. Both are already generated in the repo root
#    .env as GUESTBOOK_ADMIN_TOKEN and GUESTBOOK_IP_SALT — paste those values:
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put IP_SALT

npm run deploy
```

## Local development

```sh
npm run schema:local
npm run dev            # http://localhost:8787
```

`.dev.vars` carries Cloudflare's documented always-passes Turnstile test keys, so
the form works locally before a real widget exists. **Note what that means:** the
local Worker accepts any token, so local testing exercises validation and the
rate limits, not Turnstile itself.

Point the site at it with `VITE_GUESTBOOK_API=http://localhost:8787 npm run dev`
from the repo root.
