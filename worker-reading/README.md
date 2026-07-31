# Reading API (Cloudflare Worker)

Backs [`cailinpitt.com/reading`](https://cailinpitt.com/reading). Two sources,
two very different ingest paths, one read API:

- **Books** — pulled from [hardcover.app](https://hardcover.app)'s GraphQL API on
  a **daily cron** into D1.
- **Articles** — **pushed** to `/ingest` from an iOS/macOS share-sheet Shortcut
  or a desktop bookmarklet. The Worker fetches the page's social card and stores
  it, and the same endpoint annotates and removes.

| File | What it does |
|---|---|
| `src/index.ts` | `scheduled` (daily sync) and `fetch` (read API + `/ingest`) |
| `src/hardcover.ts` | hardcover.app GraphQL client |
| `src/sync.ts` | full-replace library ingest into D1 |
| `src/articles.ts` | url canonicalization + save / annotate / remove |
| `src/metadata.ts` | og:/twitter: extraction via `HTMLRewriter` |
| `src/images.ts` | mirrors covers + social cards into R2 |
| `src/store.ts` | D1 reads for the bundle and article pagination |
| `schema.sql` | the `books`, `articles`, and `stats` tables |

## Design notes

### No KV, unlike the listening worker

That worker precomputes JSON blobs into KV because it has ~100k scrobbles and a
per-minute cron. This one has a few hundred books and a few thousand articles,
so every query in `src/store.ts` is a small indexed scan and the bundle is built
straight from D1 behind a 5-minute edge cache. Adding KV here would be a
staleness ladder to reason about in exchange for nothing.

### Caching, and how it stays on the free tier

Three layers, none of which are optional if this is to survive traffic:

| Layer | What | Lifetime |
|---|---|---|
| Browser | `cache-control: public, max-age=300` on every read endpoint | 5 min |
| Cloudflare edge | `caches.default`, keyed per path + variant | 5 min |
| R2 / images | `immutable, max-age=31536000`, content-addressed keys | 1 year |

The page itself is static HTML on GitHub Pages, so a `/reading` visit costs this
Worker exactly **one** request for the bundle. `/books` and `/articles` are only
fetched if someone clicks "load older".

**Cost per bundle build** (i.e. per edge cache miss):

| Query | D1 rows |
|---|---|
| currently reading | ~2 |
| first page of finished books | 25 |
| first page of articles | 21 |
| `stats` (precomputed totals) | 1 |
| **total** | **~49** |

That number is *flat*: it does not grow as the archive grows. Getting there took
two fixes, both worth preserving:

- **Pagination, not full history.** The bundle used to carry every finished
  book. Since it is rebuilt per edge colo per TTL, payload size multiplies by
  traffic — so the history is unbounded but the bundle must not be.
- **No `COUNT(*)` at runtime.** The totals were four subqueries scanning every
  finished book and every article: ~750 rows per build, rising forever. They are
  now one precomputed row (see the `stats` table in `schema.sql`).

Against the free tier, with D1's 5M row-reads/day the binding constraint is
Workers' **100k requests/day**, which is ~100k `/reading` visits — the edge cache
does not reduce that number, because the Cache API runs *inside* the Worker. D1
reads only become interesting above ~100k builds/day, which the 5-minute TTL puts
well out of reach. If it ever did get close, raising `EDGE_TTL` is the lever.

Writes are negligible: the daily sync writes ~430 rows once, and an article
ingest writes two.

### Saving an article

`POST /ingest` with a bearer token. The Worker fetches the page, pulls its
`og:` metadata, mirrors the social image to R2, and stores the row:

```bash
curl -sX POST https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://arstechnica.com/...","note":"optional"}'
```

`INGEST_TOKEN` is separate from `ADMIN_TOKEN` on purpose: it lives on a phone and
inside a bookmarklet, and all it can do is add an article.

Unlike the read endpoints, `/ingest` allows **any** origin. The bookmarklet runs
in the page context of whatever article is open, so the origin is arbitrary by
design and an allowlist can't work — the token is the security boundary.

One path, three verbs, every one keyed by the url you shared (tracking params and
all — they're canonicalized away before hashing), so you never need to look up an
id:

| Verb | Body | Does |
|---|---|---|
| `POST` | `{"url": "…", "note": "…"}` | save it (`note` optional) |
| `PATCH` | `{"url": "…", "note": "…", "append": true}` | set or extend the note |
| `DELETE` | `{"url": "…"}` | remove it |

`PATCH` and `DELETE` also accept `{"id": "…"}` instead, for correcting something
straight off a D1 listing when you don't have the url to hand. `PATCH` with
`"note": ""` clears a note; `"append": true` adds to the existing one rather than
replacing it, so a second thought doesn't wipe the first.

```bash
# fix a note after the fact
curl -sX PATCH https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://arstechnica.com/...","note":"actually this is the good one"}'

# remove one you saved by accident
curl -sX DELETE https://reading.cailinpitt.com/ingest \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://arstechnica.com/..."}'
```

Deleting leaves the mirrored image in R2 on purpose: keys are content-addressed,
so re-saving the article reuses the object, and `prune-r2.mjs` never touches this
prefix. A few KB is cheaper than risking the deletion of an image another row
still points at.

#### iOS / macOS share sheet

Three shortcuts, all built the same way. Shortcuts → new shortcut → **Get
Contents of URL**, then in settings enable **Show in Share Sheet** with accepted
input *URLs* and *Safari web pages*. Each one gets
`authorization` = `Bearer <INGEST_TOKEN>` as a header.

**"Save to reading"** — URL `https://reading.cailinpitt.com/ingest`, method
**POST**, Request Body **JSON** with key `url` = **Shortcut Input**.

**"Save to reading with note"** — same, plus an **Ask for Input** action (Text,
prompt "Note?") and a second JSON key `note` = that action's output.

> Order matters, and this is easy to get wrong: Shortcuts defaults every
> action's input to the *previous action's output*. If **Ask for Input** sits
> above **Get URLs from Input**, that action silently starts looking for a url
> inside the note you typed, `url` comes out empty, and the API rejects the body.
> Either keep **Get URLs from Input** first, or set its input explicitly to
> **Shortcut Input** rather than leaving the default.

Saving a link you already saved is a no-op *except* for the note — an explicit
note is always written, so this works whether or not the article was logged
earlier. The response says `noted: true` when that happens.

**"Remove from reading"** — same URL, method **DELETE**, JSON body with just
`url` = **Shortcut Input**. Share the page again and pick this to undo a save.

#### Desktop bookmarklets

New bookmark, with one of these as the URL (substitute the token):

```js
// Save
javascript:(()=>{fetch('https://reading.cailinpitt.com/ingest',{method:'POST',headers:{'authorization':'Bearer INGEST_TOKEN_HERE','content-type':'application/json'},body:JSON.stringify({url:location.href})}).then(r=>r.json()).then(r=>alert(r.error||(r.stored?'Saved':'Already saved'))).catch(e=>alert('Failed: '+e))})()

// Save with a note (prompts; cancel saves without one)
javascript:(()=>{const n=prompt('Note?');fetch('https://reading.cailinpitt.com/ingest',{method:'POST',headers:{'authorization':'Bearer INGEST_TOKEN_HERE','content-type':'application/json'},body:JSON.stringify({url:location.href,note:n||''})}).then(r=>r.json()).then(r=>alert(r.error||(r.stored?'Saved':'Already saved'))).catch(e=>alert('Failed: '+e))})()

// Remove
javascript:(()=>{if(!confirm('Remove from reading?'))return;fetch('https://reading.cailinpitt.com/ingest',{method:'DELETE',headers:{'authorization':'Bearer INGEST_TOKEN_HERE','content-type':'application/json'},body:JSON.stringify({url:location.href})}).then(r=>r.json()).then(r=>alert(r.error||'Removed')).catch(e=>alert('Failed: '+e))})()
```

### The subrequest budget is the real constraint

On the Workers **free plan** an invocation gets **50 subrequests**, and R2, KV,
and D1 binding calls count toward it alongside `fetch()`. That shapes two things:

- `mirrorImage()` spends exactly **two** subrequests per image (one fetch, one
  R2 put) and never calls `head()` to test for an existing key. Callers avoid
  redundant work instead — `syncBooks()` reads the `cover_source → cover` map
  out of D1 first, so a steady-state sync makes no image subrequests at all.
- New covers are mirrored **`MIRROR_BUDGET` per run** (default 18) and whatever
  is left over is picked up by the next run; those books render a placeholder in
  the meantime. On Workers Paid (10,000 subrequests) raise it to 400+ in
  `wrangler.jsonc` and the whole library mirrors in one pass.

A first sync of a few hundred books therefore needs several passes. See
"Backfilling covers" below — there is no separate backfill script, because the
daily sync already imports the entire history on its first run.

### Books are replaced, not appended

Hardcover is the source of truth and rows there can be edited or deleted, so
`syncBooks()` does `DELETE FROM books` + re-insert inside a single atomic D1
batch. At this size that is cheaper and more correct than diffing, and deletions
and edits come free. Rows are per *read session*, so a re-read is its own row.

`ROWS_PER_INSERT` is 7 because D1 caps bound parameters at 100 per query and
each row binds 13.

## Setup

### 1. Hardcover token

Create one at <https://hardcover.app/account/api> (valid one year). Put it in the
repo-root `.env` as `HARDCOVER_TOKEN` so the probe script can use it, then:

```bash
npx wrangler secret put HARDCOVER_TOKEN
```

### 2. Database

```bash
npm install
npx wrangler d1 create cailinpitt-reading   # paste database_id into wrangler.jsonc
npm run schema:remote
```

### 3. Ingest token

```bash
openssl rand -hex 24
npx wrangler secret put INGEST_TOKEN
```

Then set up the share-sheet Shortcut and/or the bookmarklet with that value —
see "Saving an article" above.

### 4. Deploy

```bash
npm run deploy
```

Then point the site at it with `VITE_READING_API` at build time (defaults to
`https://reading.cailinpitt.com`).

## Testing it in pieces

### Books, without deploying anything

```bash
npm run reading:probe          # from the repo root; needs HARDCOVER_TOKEN in .env
npm run reading:probe -- --json | head -40
```

This runs the *exact* queries `src/hardcover.ts` uses and prints what came back:
book counts by status, how many have covers/authors/dates, what you're currently
reading, and the five most recently finished. It is the fastest way to confirm
the query shape — in particular that Hardcover's **max query depth of 3** is
satisfied, which is why authors are fetched separately by `book_id` and joined
locally rather than through `user_books → book → contributions → author`.

### Books, into D1

Deploy, then drive the sync through `POST /sync` on the deployed Worker:

```bash
openssl rand -hex 24                  # put this value in BOTH places below
npx wrangler secret put ADMIN_TOKEN   # the Worker's copy
#                                       …and READING_ADMIN_TOKEN in the repo-root .env
npm run deploy

npm run reading:sync                  # from the repo root
```

That prints `{ books, rows, coversMirrored, coversRemaining }`. It is also how you
pick up a book you just finished without waiting for 09:00 UTC. Cloudflare secrets
are write-only, so `.env` is the only place the token can be read back from — if
the two drift, `/sync` returns 401 and you re-put both.

> **Why not `wrangler dev --remote`?** It works, but it is fiddly: it needs
> `--test-scheduled` before `/__scheduled` exists at all (without it the request
> just hangs), it needs the custom domain to already be provisioned by a deploy,
> and it needs `preview_bucket_name` on the R2 binding. `npm run dev:remote`
> bundles those flags if you want it, but `POST /sync` against the deployed
> Worker is the shorter path and exercises the real thing.

`preview_bucket_name` in `wrangler.jsonc` deliberately points at the *same*
bucket the site serves, since covers have to land where they'll be read from.
That's safe because R2 keys here are a SHA-256 of the source url and uploaded
immutable, so any run can only rewrite a key with identical bytes — it can't
touch the photo galleries.

Then look at what landed:

```bash
npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT COUNT(*) AS rows, COUNT(DISTINCT user_book_id) AS books,
             SUM(cover IS NOT NULL) AS with_cover FROM books"

npx wrangler d1 execute cailinpitt-reading --remote \
  --command "SELECT title, authors, status_id, started_at, finished_at
             FROM books ORDER BY finished_at DESC LIMIT 10"
```

and check the API:

```bash
curl -s localhost:8787/reading.json | jq '.counts, (.currentlyReading|map(.title))'
```

#### Backfilling covers

`coversRemaining` counts down by `MIRROR_BUDGET` (18) per run, so a library of
~420 books needs a couple of dozen passes. Loop it, but **sleep between runs**:
each pass also re-fetches the library, and Hardcover rate-limits at 60
requests/minute.

```bash
npm run reading:sync -- --covers    # from the repo root
```

That loops `POST /sync` until `coversRemaining` stops coming down, pacing itself
at 6s between passes because each one re-fetches the library and Hardcover
rate-limits at 60 requests/minute. It stops on its own when the remainder
plateaus — some books have no cover url on Hardcover at all and will never
mirror; those render a placeholder.

Watch `coversRemaining` in the `wrangler dev` log; stop when it reaches 0. Some
books legitimately have no cover url on Hardcover and stay at `cover = NULL`
forever — the probe reports that count too.

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

- **Idempotency** — post the same link again with `?utm_source=x` appended.
  Still one row, `stored: false`, and the original `read_at` is kept: the id is a
  hash of the *canonical* url, with tracking parameters stripped.
- **Authorization** — post without the header, or with a wrong token. 401, and
  nothing is stored.
- **A page with no OpenGraph tags** — the row is still created, `site` falls back
  to the hostname, and the card renders a placeholder instead of art.

`canonicalizeUrl` is exported from `src/articles.ts` if you want to check the
normalization rules directly.

## Read endpoints

- `GET /reading.json` — the bundle: `currentlyReading`, `recentBooks`,
  `articles` (first page), `counts`, `nextCursor`.
- `GET /articles?cursor=<opaque>&limit=<n>` — older articles, for "load older".
  The cursor is `<read_at>:<id>`, composite because two articles mailed in the
  same second are possible and a bare timestamp cursor would drop one at the
  page boundary.
- `GET /` — 302 to `cailinpitt.com/reading`, `no-store`.
- `POST /ingest` — saves an article. Body `{"url": "…", "note": "…"}`.
- `PATCH /ingest` — sets or (with `"append": true`) extends its note.
- `DELETE /ingest` — removes it.

  All three require `authorization: Bearer $INGEST_TOKEN`, accept `url` or `id`,
  allow any origin, and are never cached.
- `POST /sync` — runs the Hardcover sync now. Requires
  `authorization: Bearer $ADMIN_TOKEN`; 401s otherwise, with a constant-time
  comparison so the token can't be recovered by timing. Never cached.

## R2

Covers and social cards are mirrored into the **same bucket the photo galleries
use**, under `images/reading/`, and served from `images.cailinpitt.com`.

`scripts/prune-r2.mjs` decides what to delete by reading the repo, and these
objects are referenced only from D1 — invisible from there. It has a
`PROTECTED_PREFIXES` guard listing `images/reading/` for exactly that reason.
**Do not remove it**: without it, `npm run images:prune -- --delete` would wipe
every cover off the site.
