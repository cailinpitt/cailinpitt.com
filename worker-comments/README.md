# Comments API (Cloudflare Worker)

Backs the comment thread under each post on [`cailinpitt.com/blog`](https://cailinpitt.com/blog).
Sibling to `worker-guestbook` — same write gauntlet, same instant-publish-then-moderate design —
scoped per post instead of sitewide. See that worker's README for the full write-gauntlet
reasoning.

| File | What it does |
|---|---|
| `src/index.ts` | routing, CORS, edge cache, the write gauntlet, admin routes |
| `src/validate.ts` | input rules, plus the post-path shape check |
| `src/turnstile.ts` | siteverify call |
| `src/store.ts` | all D1 access |
| `src/hash.ts` | salted IP hashing + comment ids |
| `schema.sql` | the single `comments` table |

## Endpoints

| Route | Auth | Cache |
|---|---|---|
| `GET /comments.json?post=&before=&limit=` | — | edge, 30s |
| `POST /comments` | Turnstile + origin + rate limits | never |
| `GET /admin/comments?limit=` | `Bearer ADMIN_TOKEN` | never |
| `DELETE /comments/:id` | `Bearer ADMIN_TOKEN` | never |

`post` is a post's path, e.g. `/blog/2026/8/21/some-slug` (`Post.path` in `src/lib/posts.ts` —
month/day aren't zero-padded, they're whatever the frontmatter `path:` says).

## Setup

```sh
npm install

npx wrangler d1 create cailinpitt-comments   # paste the id into wrangler.jsonc
npm run schema:remote

# Reuses worker-guestbook's Turnstile widget — same secret value works here too.
npx wrangler secret put TURNSTILE_SECRET

# Values in repo-root .env as COMMENTS_ADMIN_TOKEN / COMMENTS_IP_SALT
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put IP_SALT

npm run deploy
```

`IP_SALT` doesn't need to match the guestbook's — a fresh one keeps the two rate-limit buckets
independent.

**Local dev:**

```sh
npm run schema:local
npm run dev   # pick a port that doesn't collide with worker-guestbook's dev server
```

`.dev.vars` carries Cloudflare's test Turnstile keys, so the local Worker accepts any token.
Point the site at it with `VITE_COMMENTS_API=http://localhost:8788 npm run dev`.

## Differences from worker-guestbook

- Scoped by `post_path`; rate limits and admin listing still run across all posts.
- No `location` field.
- No curl/text view — there's no single page to browse from a terminal.
- Same Turnstile widget as the guestbook, deliberately, since one site key covers the domain.
