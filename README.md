# cailinpitt.com

Personal site: a blog, a photo feed, short notes, and a handful of pages that show what I've
been listening to, reading, watching, and doing lately. Plus a terminal, a timeline, a guestbook, a photo map.

Two other files go with this one:

- [`RUNBOOK.md`](RUNBOOK.md) — every command in the repo, grouped by what you're trying to do.
- [`docs/DESIGN.md`](docs/DESIGN.md) — why each piece works the way it does. Worth reading the relevant section before changing something.

## How it's built

React and TypeScript, built with Vite and prerendered to static HTML by
[vite-react-ssg](https://github.com/Daydreamer-riri/vite-react-ssg). Every route in `src/App.tsx`
becomes a real `.html` file, so the site works with JavaScript off and every page is crawlable.
It's hosted on GitHub Pages so pushing to `main` builds and deploys it.

Blog posts are Markdown files sitting in `content/` next to the code. A few other pages are markdown as well (`now`, `uses`, `colophon`, `about`, `projects`)

Anything a static site can't do is handled by a Cloudflare Worker on its own subdomain. The pages
fetch the Worker's JSON in the browser and show nothing until it lands, so if a Worker is down the
page just loses that one strip. Each Worker has its own storage and its own README, and I deploy them separately from the site.

## The Workers

- **worker-listening** (`listening.cailinpitt.com`) — pulls my Last.fm scrobbles into D1 on a cron and keeps precomputed aggregates in KV. Backs `/listening` and the yearly wrapped pages.
- **worker-reading** (`reading.cailinpitt.com`) — my books from [Hardcover](https://hardcover.app) once a day, plus articles I save from my phone. Cover art mirrors to R2.
- **worker-watching** (`watching.cailinpitt.com`) — films from my Letterboxd RSS diary.
- **worker-moving** (`moving.cailinpitt.com`) — bike rides and lifts, pulled from Strava.
- **worker-notes** (`notes.cailinpitt.com`) — microblog. Notes live only in D1.
- **worker-guestbook** (`guestbook.cailinpitt.com`) — the only endpoint that takes public writes. It uses Honeypot, Turnstile, and rate limits.
- **worker-comments** (`comments.cailinpitt.com`) — same design as the guestbook, scoped to one
  post instead of the whole site.
- **worker-photos** (`photos.cailinpitt.com`) — takes photos straight off my phone through an iOS Shortcut and kicks off a build.

Each folder has a README with that Worker's API, schema, and first-time setup.

## Where the content lives

- **Blog posts** — `content/blog/<slug>.md`. Picked up by a glob, nothing to wire up; the
  frontmatter sets the URL.
- **Single-file pages** — `content/now.md`, `uses.md`, `colophon.md`, `about.md`, `projects.md`.
- **Photos** — `src/lib/photos.json`, a manifest the image scripts rebuild from `originals/`. The
  photo files themselves are never committed.
- **Concerts** — `src/lib/concerts.json`, imported from a Concert Archives CSV. No Worker for this
  one.
- **Notes** — nowhere in the repo. They're in D1.

Images are served from Cloudflare R2 at `images.cailinpitt.com`. Both `images/` (the compressed
versions) and `originals/` (the full-size files) are gitignored — `images/` is just a staging area
that one script fills and another uploads.

## Repo layout

```
src/
  App.tsx       the route table — every path here gets prerendered
  pages/        one component per route
  components/   shared UI
  lib/          the pure logic: parsing, dates, diffing, manifests. Most of what the tests cover.
content/        blog posts and the single-file pages
scripts/        the build generators, plus every sync / backfill / moderation CLI
tests/          vitest — pure functions and build invariants, no network
worker-*/       the eight Workers, each self-contained
public/         copied straight into the build (CNAME, web manifest, favicons)
```

## Running it

You need Node 22 and npm.

```bash
npm install
npm run dev        # localhost:5173
npm run typecheck
npm test           # fast, no network
npm run build      # prerender into dist/
npm run preview    # serve what you just built
```

`dev` and `build` don't need any credentials because the live pages just talk to the production Workers.
To point one at a Worker running locally, set its `VITE_*_API` variable (see
[RUNBOOK.md](RUNBOOK.md#develop)).

The scripts under `scripts/` all need secrets. Copy `.env.example` to `.env` and fill in what you need. 
[RUNBOOK.md](RUNBOOK.md#credentials) says where each value comes from.

`npm run build` does the prerender, then a chain of generators: the sitemap, `llms.txt`, the RSS
feed, a `.md` copy of every post and page, social cards, Bluesky records. CI checks out full git
history, because the "edited N times" line at the foot of each post is read from `git log` at build
time.

## Deploying

The site deploys itself: push to `main`, GitHub Actions runs typecheck → test → build and publishes
to Pages. A failing test stops the deploy.

The Workers don't — a push to `main` never touches them. Deploy each one by hand:

```bash
cd worker-listening && npm run deploy
```

First-time setup for a Worker (D1 schema, secrets, cron) is in its own README.
