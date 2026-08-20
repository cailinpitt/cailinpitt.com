# Reading API (Cloudflare Worker)

Backs [`cailinpitt.com/reading`](https://cailinpitt.com/reading). Two sources, two ingest paths,
one read API:

- **Books** — pulled from [hardcover.app](https://hardcover.app)'s GraphQL API on a daily cron.
- **Articles** — pushed to `/ingest` from an iOS/macOS Shortcut or a desktop bookmarklet. The
  Worker fetches the page's social card and stores it; the same endpoint annotates and removes.

| File | What it does |
|---|---|
| `src/index.ts` | `scheduled` (daily sync) and `fetch` (read API + `/ingest`) |
| `src/hardcover.ts` | hardcover.app GraphQL client |
| `src/sync.ts` | full-replace library ingest into D1 |
| `src/articles.ts` | url canonicalization + save / annotate / remove |
| `src/metadata.ts` | og:/twitter: extraction via `HTMLRewriter` |
| `src/images.ts` | mirrors covers + social cards into R2 |
| `src/store.ts` | D1 reads for the bundle and article pagination |
| `src/text.ts` | the `curl reading.cailinpitt.com` view |
| `schema.sql` | `books`, `articles`, `stats` |

## Endpoints

| Route | Auth | Notes |
|---|---|---|
| `GET /reading.json` | — | the bundle: `currentlyReading`, `recentBooks`, `articles`, `counts`, `nextCursor` |
| `GET /articles?cursor=&limit=` | — | older articles. Cursor is `<read_at>:<id>` — composite, so two articles saved in the same second don't drop one at a page boundary |
| `GET /` or `/reading` | — | terminal view for CLI user-agents, else a 302 (`no-store`) |
| `POST /ingest` | `Bearer INGEST_TOKEN` | save an article |
| `PATCH /ingest` | `Bearer INGEST_TOKEN` | set or extend its note |
| `DELETE /ingest` | `Bearer INGEST_TOKEN` | remove it |
| `POST /sync` | `Bearer ADMIN_TOKEN` | run the Hardcover sync now (constant-time token compare) |

`/ingest` accepts `url` or `id`, allows any origin, and is never cached.

## Setup

```bash
npm install

# 1. Hardcover token — https://hardcover.app/account/api (valid one year).
#    Also put it in the repo-root .env as HARDCOVER_TOKEN for the probe script.
npx wrangler secret put HARDCOVER_TOKEN

# 2. Database — paste database_id into wrangler.jsonc
npx wrangler d1 create cailinpitt-reading
npm run schema:remote

# 3. Tokens. Put the same values in the repo-root .env as INGEST_TOKEN and
#    READING_ADMIN_TOKEN — Cloudflare secrets are write-only, so .env is the
#    only place they can be read back from.
openssl rand -hex 24
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put ADMIN_TOKEN

npm run deploy
```

Then set `VITE_READING_API` at build time (defaults to `https://reading.cailinpitt.com`).

`INGEST_TOKEN` is separate from `ADMIN_TOKEN` on purpose: it lives on a phone and inside a
bookmarklet, and all it can do is add an article.

## Saving an article

```bash
curl -sX POST https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://arstechnica.com/...","note":"optional"}'
```

One path, three verbs, all keyed by the url you shared (tracking params and all —
canonicalized away before hashing), so you never need an id:

| Verb | Body | Does |
|---|---|---|
| `POST` | `{"url": "…", "note": "…"}` | save it (`note` optional) |
| `PATCH` | `{"url": "…", "note": "…", "append": true}` | set or extend the note |
| `DELETE` | `{"url": "…"}` | remove it |

`PATCH` with `"note": ""` clears a note; `"append": true` adds to the existing one rather than
replacing it. Both `PATCH` and `DELETE` also take `{"id": "…"}`.

Saving a link twice is a no-op *except* for the note — an explicit note is always written, and the
response says `noted: true`.

Deleting leaves the mirrored image in R2 on purpose: keys are content-addressed, so re-saving
reuses the object, and `prune-r2.mjs` never touches this prefix. A few KB is cheaper than risking
deletion of an image another row still points at.

`/ingest` allows **any** origin. The bookmarklet runs in the page context of whatever article is
open, so an allowlist can't work — the token is the security boundary.

### iOS / macOS share sheet

Three shortcuts, all built the same way: Shortcuts → new shortcut → **Get Contents of URL**, then
in settings enable **Show in Share Sheet** accepting *URLs* and *Safari web pages*. Each gets
`authorization` = `Bearer <INGEST_TOKEN>` as a header.

- **"Save to reading"** — URL `https://reading.cailinpitt.com/ingest`, method **POST**, Request
  Body **JSON**, key `url` = **Shortcut Input**.
- **"Remove from reading"** — same, method **DELETE**.
- **"Save to reading with note"** — three actions, in this order:

  ```
  1. Get URLs from Input          ← must be FIRST
  2. Ask for Text  "Note?"
  3. Get Contents of URL          url → URLs, note → Ask for Input
  ```

  > Order is load-bearing. Shortcuts defaults every action's input to the *previous action's
  > output*, so if **Ask for Input** sits above **Get URLs from Input**, that action hunts for a
  > url inside the note you typed, `url` arrives empty, and the API rejects the body. The variable
  > picker doesn't reliably offer "Shortcut Input", so relying on the default order is the
  > dependable fix.

### Desktop bookmarklets

New bookmark, one of these as the URL (substitute the token):

```js
// Save
javascript:(()=>{fetch('https://reading.cailinpitt.com/ingest',{method:'POST',headers:{'authorization':'Bearer INGEST_TOKEN_HERE','content-type':'application/json'},body:JSON.stringify({url:location.href})}).then(r=>r.json()).then(r=>alert(r.error||(r.stored?'Saved':'Already saved'))).catch(e=>alert('Failed: '+e))})()

// Save with a note (prompts; cancel saves without one)
javascript:(()=>{const n=prompt('Note?');fetch('https://reading.cailinpitt.com/ingest',{method:'POST',headers:{'authorization':'Bearer INGEST_TOKEN_HERE','content-type':'application/json'},body:JSON.stringify({url:location.href,note:n||''})}).then(r=>r.json()).then(r=>alert(r.error||(r.stored?'Saved':'Already saved'))).catch(e=>alert('Failed: '+e))})()

// Remove
javascript:(()=>{if(!confirm('Remove from reading?'))return;fetch('https://reading.cailinpitt.com/ingest',{method:'DELETE',headers:{'authorization':'Bearer INGEST_TOKEN_HERE','content-type':'application/json'},body:JSON.stringify({url:location.href})}).then(r=>r.json()).then(r=>alert(r.error||'Removed')).catch(e=>alert('Failed: '+e))})()
```

## Design notes

### No KV, unlike the listening worker

That worker precomputes blobs into KV because it has ~100k scrobbles and a per-minute cron. This
one has a few hundred books and a few thousand articles, so every query in `src/store.ts` is a
small indexed scan and the bundle is built straight from D1 behind a 5-minute edge cache. KV here
would be a staleness ladder in exchange for nothing.

### Caching

| Layer | What | Lifetime |
|---|---|---|
| Browser | `cache-control: public, max-age=300` on every read endpoint | 5 min |
| Cloudflare edge | `caches.default`, keyed per path + variant | 5 min |
| R2 / images | `immutable, max-age=31536000`, content-addressed keys | 1 year |

The page is static HTML on GitHub Pages, so a `/reading` visit costs exactly **one** request.
`/books` and `/articles` are only fetched on "load older".

**Cost per bundle build** (per edge cache miss) is ~49 D1 rows: ~2 currently reading, 25 finished
books, 21 articles, 1 precomputed `stats` row. That number is **flat** — it doesn't grow with the
archive. Two fixes got it there, both worth preserving:

- **Pagination, not full history.** The bundle used to carry every finished book. It's rebuilt per
  edge colo per TTL, so payload size multiplies by traffic — history is unbounded but the bundle
  must not be.
- **No `COUNT(*)` at runtime.** Totals were four subqueries scanning every finished book and
  article (~750 rows per build, rising forever). Now one precomputed `stats` row.

The binding free-tier constraint is Workers' **100k requests/day**, i.e. ~100k `/reading` visits —
the edge cache doesn't reduce that, since the Cache API runs *inside* the Worker. D1 reads only
matter above ~100k builds/day, which the TTL puts out of reach; `EDGE_TTL` is the lever if it ever
gets close. Writes are negligible.

### The subrequest budget is the real constraint

On the free plan an invocation gets **50 subrequests**, and R2/KV/D1 binding calls count alongside
`fetch()`. That shapes two things:

- `mirrorImage()` spends exactly **two** subrequests per image (one fetch, one R2 put) and never
  calls `head()` to test for an existing key. Callers avoid redundant work instead —
  `syncBooks()` reads the `cover_source → cover` map out of D1 first, so a steady-state sync makes
  no image subrequests at all.
- New covers are mirrored **`MIRROR_BUDGET` per run** (default 18); the rest are picked up next
  run and render a placeholder meanwhile. On Workers Paid (10,000 subrequests) raise it to 400+ in
  `wrangler.jsonc` and the library mirrors in one pass.

So a first sync of a few hundred books needs several passes — see [Backfilling
covers](#backfilling-covers).

### Books are replaced, not appended

Hardcover is the source of truth and rows there can be edited or deleted, so `syncBooks()` does
`DELETE FROM books` + re-insert in a single atomic D1 batch. At this size that's cheaper and more
correct than diffing, and deletions/edits come free. Rows are per *read session*, so a re-read is
its own row. `ROWS_PER_INSERT` is 7 because D1 caps bound parameters at 100 and each row binds 13.

## Testing in pieces

### Books, without deploying

```bash
npm run reading:probe                     # from the repo root; needs HARDCOVER_TOKEN in .env
npm run reading:probe -- --json | head -40
```

Runs the *exact* queries `src/hardcover.ts` uses and prints what came back: counts by status, how
many have covers/authors/dates, what you're currently reading, the five most recently finished.
The fastest way to confirm the query shape — in particular that Hardcover's **max query depth of
3** is satisfied, why authors are fetched separately by `book_id` and joined locally rather than
through `user_books → book → contributions → author`.

### Books, into D1

Deploy, then drive the sync through `POST /sync`:

```bash
npm run reading:sync                  # from the repo root
```

Prints `{ books, rows, coversMirrored, coversRemaining }` — also how to pick up a book you just
finished without waiting for 09:00 UTC. If `ADMIN_TOKEN` and `READING_ADMIN_TOKEN` in `.env`
drift, `/sync` returns 401 — re-put both.

Then look at what landed:

```bash
npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT COUNT(*) AS rows, COUNT(DISTINCT user_book_id) AS books,
             SUM(cover IS NOT NULL) AS with_cover FROM books"
```

> **Why not `wrangler dev --remote`?** It works but is fiddly: needs `--test-scheduled` before
> `/__scheduled` exists (without it the request just hangs), the custom domain must already be
> provisioned by a deploy, and the R2 binding needs `preview_bucket_name`. `npm run dev:remote`
> bundles those flags, but `POST /sync` against the deployed Worker is shorter and exercises the
> real thing.

`preview_bucket_name` deliberately points at the *same* bucket the site serves, since covers have
to land where they'll be read from. Safe because R2 keys here are a SHA-256 of the source url,
uploaded immutable — any run can only rewrite a key with identical bytes.

#### Backfilling covers

```bash
npm run reading:sync -- --covers    # from the repo root
```

Loops `POST /sync`, pacing at 6s between passes since each re-fetches the library and Hardcover
rate-limits at 60 requests/minute. `coversRemaining` counts down by `MIRROR_BUDGET` (18) per run,
so ~420 books needs a couple dozen passes. Stops when the remainder plateaus — some books have no
cover url on Hardcover at all and stay `cover = NULL` forever, rendering a placeholder. The probe
reports that count.

Confirm one landed:

```bash
npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT cover FROM books WHERE cover IS NOT NULL LIMIT 1"
curl -sI https://images.cailinpitt.com/images/reading/<hash>.jpg | head -1   # want: 200
```

### Articles

```bash
export INGEST_TOKEN=…
curl -sX POST https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://arstechnica.com/some-article/","note":"testing"}' | jq

npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT url, title, site, image, note, read_at FROM articles ORDER BY read_at DESC LIMIT 5"
```

Worth checking explicitly:

- **Idempotency** — post the same link with `?utm_source=x` appended. Still one row, `stored:
  false`, original `read_at` kept: the id hashes the *canonical* url.
- **Authorization** — no header or a wrong token. 401, nothing stored.
- **A page with no OpenGraph tags** — row still created, `site` falls back to the hostname, card
  renders a placeholder.

`canonicalizeUrl` is exported from `src/articles.ts` if you want to check the rules directly.

## Terminal view

```bash
curl reading.cailinpitt.com     # color
curl reading.cailinpitt.com?T   # no color
```

A 72-column ANSI page. Dispatch rules match the listening worker's — see
[`worker-listening/README.md`](../worker-listening/README.md#terminal-view). Shows what you're
reading now (falling back to the last book finished, so the top is never blank between books),
this year and all-time counts, the last 8 books finished with ratings, and the last 8 articles
grouped by day.

The renderer deliberately copies the listening worker's helpers (`clip`, `fit`, `ink`, `stars`)
rather than sharing a module — the two Workers are separate packages with separate deploys, and a
shared package would couple them for about 60 lines of string padding.

## R2

Covers and social cards are mirrored into the **same bucket the photos use**, under
`images/reading/`, served from `images.cailinpitt.com`.

`scripts/prune-r2.mjs` decides what to delete by reading the repo, and these objects are
referenced only from D1 — invisible from there. Its `PROTECTED_PREFIXES` guard lists
`images/reading/` for exactly that reason. **Do not remove it**: without it, `npm run
images:prune -- --delete` would wipe every cover off the site.
