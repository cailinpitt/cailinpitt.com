# worker-notes

The microblog behind [cailinpitt.com/notes](https://cailinpitt.com/notes). One D1 table, one
bearer token, and no build step: a note is live seconds after it is typed, from a phone or from
the compose page.

```
phone Shortcut ─┐
                ├─→ POST /notes ─→ D1 ─→ /notes.json ─→ the /notes page
/notes/compose ─┘                   ├─→ /feed.xml    ─→ RSS readers
                                     └─→ cailinpitt.com/notes/<id> ─→ a shared link
```

## The one decision worth understanding

**Nothing here is prerendered, and that is the point.**

Everything else on the site is static HTML written at build time. The photo pipeline goes to real
trouble — a Worker, a `repository_dispatch`, a workflow, a commit — so that a photo sent from a
phone is the same kind of object as one added from a laptop: prerendered, permalinked, with a
social card. Notes deliberately do not do that.

A thought worth 480 characters is worth publishing in the two seconds it takes to type it. A note
that had to wait for a green CI run before appearing would simply not get written, which makes the
feature pointless however well-built it is. So notes live in D1 and the page fetches them.

The costs are real and are accepted:

| | |
|---|---|
| **No page built for a note at deploy time** | GitHub Pages has no router that could resolve `/notes/<id>` into anything, and the site [rejected the `404.html` redirect hack](../plan.md) years ago for good reasons. Instead this Worker renders one on request — see [Permalink](#permalink--cailinpittcomnotesid) below — which costs a Worker route on the apex zone rather than a build step, and keeps the "live the moment it's published" property intact |
| **Invisible to crawlers that don't run JS** | The permalink's HTML carries real `<meta property="og:...">` tags for a link-unfurl bot, but a general crawler indexing the page gets redirected into the SPA like any other browser. `/feed.xml` below is what keeps notes syndicable either way |
| **A Worker outage empties the page** | Same contract as `/listening` and `/reading` — the prerendered shell stays, the content doesn't arrive |

If a note ever deserves to be a real page, it wasn't a note. It was a post, and `content/blog/`
is where it goes.

## Setup

```sh
npm install
wrangler d1 create cailinpitt-notes     # paste the id into wrangler.jsonc
npm run schema:remote                    # create the table
wrangler secret put PUBLISH_TOKEN        # openssl rand -hex 32
npm run deploy
```

`PUBLISH_TOKEN` is the entire security boundary. There is no Turnstile and no origin check,
because the primary client is an iOS Shortcut and a share sheet has no origin — see the note on
`corsHeaders` in `src/index.ts`. Keep it long and random, and rotate it to revoke a lost phone.

Local:

```sh
npm run schema:local
npm run dev                              # http://localhost:8787
```

Point the site at it with `VITE_NOTES_API=http://localhost:8787` in the repo root's `.env`.

## API

### Writes — `PUBLISH_TOKEN` only, never cached

| | |
|---|---|
| `POST /notes` | Publish. Returns `{ ok, note, url }` |
| `PATCH /notes/:id` | Rewrite, stamping `edited_at`. Returns the updated note |
| `DELETE /notes/:id` | Immediate and permanent, like `guestbook:rm` |

`text` is read from JSON, a form field, or the raw body — whichever the caller found easiest. The
form and raw shapes exist for Shortcuts, whose *Get Contents of URL* action makes JSON awkward to
build by hand; the same accommodation `worker-photos` makes, for the same reason.

A JSON body may also carry `contextType` (`"photo"` | `"activity"` | `"post"`) and `contextRef`
(that thing's own id — a photo id, an activity id, or a post's path), an optional reference to one
other piece of content on the site. Both or neither: one without the other is refused rather than
guessed at (`validateContext` in `src/validate.ts`). The Shortcut and raw-body paths never send
these, which is fine — every note's reference is optional.

```sh
TOKEN=…
curl -X POST https://notes.cailinpitt.com/notes \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"trains are good, actually"}'

curl -X DELETE https://notes.cailinpitt.com/notes/a3f91c2b40d1 \
  -H "authorization: Bearer $TOKEN"
```

**Editing and deleting are first-class**, because publishing from a phone means publishing typos.
An edit stamps `edited_at` and the site renders an "edited" marker from it — a permalink that
quietly changes what it says is the thing worth avoiding, not the edit.

### Reads — public, behind a 30-second edge cache

| | |
|---|---|
| `GET /notes.json?before=&limit=` | The feed, newest first. `nextCursor` pages backwards |
| `GET /now.json` | The newest note alone, for the homepage strip |
| `GET /feed.xml` | RSS, the 50 newest |
| `GET /limits.json` | `maxLength`, `pageSize`, `maxPageSize` |
| `GET /` | The terminal view for `curl`, a redirect to the site for a browser |

```sh
curl notes.cailinpitt.com          # the feed, in ANSI
curl notes.cailinpitt.com?T        # …without color
```

**The edge TTL is 30 seconds, deliberately shorter than the settled-data endpoints elsewhere on
the site**, because the whole feature is that a note appears immediately. Writes additionally
purge every unparameterized cache key (`CACHED_READS` in `src/index.ts`), so the note is usually
there before the TTL matters. Deep pages are addressed by cursor and can't be affected by a note
added at the top, so they aren't purged.

> **The purge origin comes from the request, never from a constant.** Reads are cached under this
> Worker's own hostname (`https://notes.cailinpitt.com/...`), because `cached()` keys entries by
> the request URL. The first version of `purge()` built its keys from `SITE`
> (`https://cailinpitt.com`), so the keys never matched, every purge deleted nothing, and every
> reader waited out the full TTL — a bug that is completely invisible from the outside, since a
> purge that finds no key and a purge that works look identical. Deriving the origin from the
> incoming request is what keeps the two sides in agreement, and it stays correct on a preview
> deployment or a `workers.dev` URL. The variant string is part of the key too, so `CACHED_READS`
> has to name exactly the variants the routes pass to `cached()` — including `/` **and** `/notes`,
> which are two keys for the one terminal view.

## Permalink — `cailinpitt.com/notes/<id>`

A second route on this same Worker (`wrangler.jsonc`) puts it in front of one path on the apex
zone: `cailinpitt.com` is GitHub Pages behind Cloudflare, and `{ "pattern": "cailinpitt.com/notes/*",
"zone_name": "cailinpitt.com" }` intercepts only `/notes/*` there, leaving the rest of the zone
(including `/notes` itself, and `/notes/compose`) served by GitHub Pages untouched. Inside the
Worker, a path under `/notes/*` that isn't a 4–32 hex-char id is passed straight through with
`return fetch(request)` — a same-zone `fetch()` bypasses Cloudflare's routing layer and goes
directly to the configured origin, so this can't loop back into the route that dispatched here.

For a path that *is* an id, four audiences:

| | |
|---|---|
| `?format=json` | `{ note }`, the same shape a Worker read returns. This is what `fetchNote()` in `src/lib/notes.ts` calls — a same-origin fetch from the SPA, resolving a permalink by id directly instead of paging through `/notes.json` for it |
| curl/wget/etc. | The plain-text single-note view (`renderNoteText` in `src/text.ts`) |
| a link-unfurl bot (`BOT_AGENT`) | Static HTML with real `<meta property="og:...">` tags — `noteHtml()` in `src/index.ts` — so a link shared to Slack/Discord/iMessage/etc. unfurls the note's own text rather than the feed's generic card. No `og:image`: the site's cards are rendered at build time with `satori`/`sharp` (`scripts/generate-og.mjs`), neither of which runs in a Worker |
| anyone else, i.e. a real browser | `302` to `/notes#<id>`, where the note lives inside the interactive feed. User-Agent dependent, so this one response is never cached |

The JSON and text/HTML variants are cached the same way as everything else here (`caches.default`,
30-second TTL), keyed per id since they can't sit in the blanket `CACHED_READS` list — `purgeNote()`
drops a note's three cached variants explicitly on edit and delete, in addition to the usual
`purge()`. Its cache keys are hardcoded to `SITE` rather than taken from the request, unlike
`purge()`: the permalink is only ever served on the apex zone, never on this Worker's own `notes.…`
hostname, and a write typically *arrives* on `notes.…` — using the request's origin here would
purge a key that was never written.

## Why RSS is served here rather than written at build time

`scripts/generate-rss.mjs` builds the site's own `/feed.xml` by lifting the prerendered HTML of
each post. Notes have no prerendered HTML, so that generator would have nothing to read — and a
build-time feed would only refresh when something unrelated happened to trigger a deploy.

It is a **separate feed** from the site's on purpose: someone who subscribed for essays did not
sign up for every passing thought, and the reverse is just as true. `/notes` advertises it with a
`<link rel="alternate">` of its own; `index.html` still advertises `/feed.xml` everywhere.

## Publishing from an iPhone

One Shortcut, four actions. Add it to the share sheet and the Home Screen.

1. **Ask for Input** → Text, prompt "What are you thinking?", *Allow Multiple Lines* on.
2. **Get Contents of URL**
   - URL `https://notes.cailinpitt.com/notes`
   - Method `POST`
   - Headers: `Authorization` = `Bearer <your PUBLISH_TOKEN>`
   - Request Body: **Form**, one field `text` = the *Provided Input* from step 1.
3. **Get Dictionary Value** → `url` from the response.
4. **Show Notification** → "Posted", with that URL.

Form rather than JSON because Shortcuts builds a form field from a variable in one tap and a JSON
body by hand. The Worker accepts either.

To post the current Safari page as a note, swap step 1 for *Get Current URL* and combine it with a
Text action.

## Schema

```sql
CREATE TABLE notes (
  id           TEXT    PRIMARY KEY,  -- 6 random bytes as hex; this is the permalink
  text         TEXT    NOT NULL,     -- plain text, <= 480 code points
  created_at   INTEGER NOT NULL,     -- unix seconds (UTC)
  edited_at    INTEGER,              -- unix seconds, or NULL
  context_type TEXT,                 -- 'photo' | 'activity' | 'post', or NULL
  context_ref  TEXT                  -- that thing's own id/path, or NULL
);
```

Ids are random rather than sequential for the same reason the guestbook's are: an incrementing id
would publish how many notes have ever been written, including the ones deleted a minute after
posting.

`context_type`/`context_ref` were added by `schema-v2.sql` (`ALTER TABLE`, run once against an
existing database — see the comment in that file); a fresh `schema.sql` includes them from the
start. Both are nullable and always travel together — see `validateContext()` in `src/validate.ts`.

The pagination cursor is `<created_at>_<id>`, not a bare timestamp. Two notes in the same second
is one Shortcut firing twice on a flaky connection — a thing that actually happens — and a
bare-timestamp cursor would then either skip the second note or loop on it forever.

## Notes are plain text, not Markdown

The only formatting a 480-character thought needs is a working link. `segments()` in
`src/lib/notes.ts` parses bare URLs into a data structure the page maps over, so there is no HTML
string anywhere in the pipeline and no `dangerouslySetInnerHTML` — a note cannot contribute markup
to the page no matter what was typed into it. The RSS feed is the one place a note's text meets a
parser, and `feed.ts` escapes on the way out.

That is also why validation is so short (`src/validate.ts`): bound the length, normalize the
whitespace, strip the invisibles. The guestbook's equivalent is long because it is deciding what a
stranger may store; this one only ever says no to Cailin.

## Tests

The pure half is covered from the site's suite — `tests/notes.test.ts` at the repo root imports
`validate.ts` directly, the same arrangement `worker-guestbook`'s validation uses. It pins the 480
limit against the site's copy in both directions, since the compose box counts down from its own
constant.

```sh
cd .. && npm test
```

## Deploy

Separately from the site, like every other Worker here:

```sh
npm run deploy
```

A push to `main` never touches it.
