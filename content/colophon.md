---
title: "Colophon"
lead: "What this site is made of, and roughly how much of it there is."
description: "How cailinpitt.com is built: a prerendered React site, three Cloudflare Workers, and photos on R2."
---
<p class="stat-note">Posts, words, and photos are counted at build time. The rest is read from three Cloudflare Workers described below.</p>

## Site

React and TypeScript, built with Vite and prerendered to static HTML by [vite-react-ssg](https://github.com/Daydreamer-riri/vite-react-ssg). Pushing to `main` builds the site with GitHub Actions and publishes it to GitHub Pages.

Posts are Markdown files in the repo next to the code, including this page.

My website was hosted on Squarespace for many years, but in 2026 I decided to rewrite and host it elsewhere to save money and experiment with web technologies.

I was really inspired by [dame.is](https://dame.is/) to add activity logs and the homepage description shuffler to my website. Their website is really wonderful, check it out!

## Bluesky

Every blog post is also published to my Bluesky account as a [standard.site](https://standard.site) record, so it also shows up in the [AT Protocol](https://atproto.com) network as a longform document.

## Moving parts

Three [Cloudflare Workers](https://www.cloudflare.com/products/workers/) (`Listening`, `Reading`, and `Guestbook`) power the data used by [listening](/listening), [reading](/reading), [timeline](/timeline), and the [homepage](/): `Listening` pulls scrobbles from Last.fm into a [D1](https://www.cloudflare.com/products/d1/) archive on a cron schedule. `Reading` pulls read books from my [Hardcover](https://hardcover.app) account daily and takes saved articles I send from my phone and personal computer via a POST request I make to an authenticated endpoint in this worker. Each serves a cached JSON bundle the page fetches in the browser.

The `Listening` Worker keeps its precomputed aggregates in [KV](https://www.cloudflare.com/products/kv/), so answering a request means reading a few small blobs rather than scanning the whole scrobble archive. Those are rebuilt on the cron, on slower cadences the further back they reach. The `Reading` Worker doesn't use KV at all since book and article data is written less frequently than my music data.

The `Guestbook` Worker backs the [guestbook](/guestbook), and is the only one that accepts writes from anyone but me. Entries publish instantly, behind a honeypot field, a [Turnstile](https://www.cloudflare.com/products/turnstile/) challenge, and rate limits; I delete anything unwelcome afterwards from the command line.

All three Workers also render themselves as text when accessed not through a browser:

```
curl listening.cailinpitt.com
curl reading.cailinpitt.com
curl guestbook.cailinpitt.com
```

## Photographs

{{photos}} photographs across {{galleries}} galleries, served from [Cloudflare R2](https://www.cloudflare.com/products/r2/). A local script compresses each original photo to WebP and uploads them to a bucket, so no photo is ever committed to the repo. EXIF data is read from original photos and included on the website (camera type and settings).

{{#located}}
{{located}} of them carry a location, shown on the [photo map](/photos/map). Photo locations are at a neighborhood level and not the exact spot a photo was taken.
{{/located}}
