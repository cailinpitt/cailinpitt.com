---
title: "Colophon"
lead: "What this site is made of, and roughly how much of it there is."
description: "How cailinpitt.com is built: a prerendered React site, seven Cloudflare Workers, and photos on R2."
---
<p class="stat-note">Posts, words, and photos are counted at build time. The rest is read live from the Workers described below.</p>

## Site

React and TypeScript, built with Vite and prerendered to static HTML by [vite-react-ssg](https://github.com/Daydreamer-riri/vite-react-ssg). Pushing to `main` builds the site with GitHub Actions and publishes it to GitHub Pages. Posts are Markdown files sitting in the repo next to the code, including this page.

My website was on Squarespace for years. In 2026 I got tired of paying for it and rewrote the whole thing myself, mostly as an excuse to mess around with web technologies again.

I was really inspired by [dame.is](https://dame.is/) to add activity logs and the homepage description shuffler to my website. Their website is really wonderful, check it out!

## Bluesky

Every blog post is also published to my Bluesky account as a [standard.site](https://standard.site) record, so it shows up in the [AT Protocol](https://atproto.com) network as a longform document instead of just a link card.

## Moving parts

Seven [Cloudflare Workers](https://www.cloudflare.com/products/workers/) do the things a static site can't:

- **Listening** pulls my scrobbles from Last.fm into a [D1](https://www.cloudflare.com/products/d1/) archive on a cron. It keeps precomputed aggregates in [KV](https://www.cloudflare.com/products/kv/), so loading a page means reading a few small blobs instead of scanning the entire archive.
- **Reading** pulls my books from [Hardcover](https://hardcover.app) once a day. It also takes articles I save from my phone and laptop — I send a URL to an authenticated endpoint and the Worker goes and grabs the title and cover art itself. No KV on this one, since books and articles get written way less often than my music does.
- **Watching** pulls the films I log on [Letterboxd](https://letterboxd.com) once a day, via my account's RSS feed. The feed only carries the last 50 entries, so everything older came from a one-off CSV import.
- **Moving** pulls my workout sessions once a day. The archive started as a one-off import of everything I had already logged, then the daily sync took over.
- **Guestbook** is the only one that accepts writes from anyone but me. Entries publish instantly, behind a honeypot field, a [Turnstile](https://www.cloudflare.com/products/turnstile/) challenge, and rate limits; I delete anything unwelcome afterwards from the command line.
- **Comments** is the same design as Guestbook, scoped to one blog post instead of the whole site.
- **Photos** takes photographs straight off my phone through an iOS Shortcut and kicks off a build. A couple of minutes later the photo is on the site with a page of its own.

The first five are what [listening](/listening), [reading](/reading), [watching](/watching), [moving](/moving), [timeline](/timeline), [guestbook](/guestbook), and the [homepage](/) are built on. Each serves a cached JSON bundle the page fetches in the browser. They also render themselves as text if you aren't visiting from a browser:

```
curl listening.cailinpitt.com
curl reading.cailinpitt.com
curl watching.cailinpitt.com
curl moving.cailinpitt.com
curl guestbook.cailinpitt.com
```

## Photographs

{{photos}} photographs spanning {{years}} years, served from [Cloudflare R2](https://www.cloudflare.com/products/r2/). A script compresses every original to WebP and uploads it to a bucket, so no photo is ever committed to the repo. The camera and settings listed under each one are read out of its EXIF data.

{{#located}}
{{located}} of them carry a location, plotted on the [photo map](/photos/map). Those are rounded to about a neighborhood, not the exact spot I was standing in.
{{/located}}
