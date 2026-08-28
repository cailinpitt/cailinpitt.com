---
title: "Shortlinks"
date: 2026-08-28
path: /blog/2026/8/28/shortlinks
slug: shortlinks
tags: ["Shortlinks", "Tech", "Cloudflare", "Claude"]
description: "I built a personal shortlink service – cailin.link"
image: /images/shortlinks/admin-view.webp

---
I've been interested in shortlinks for several years. Like many companies my former employer used go links (ex. typing `go/cailin` in your work machine's web browser could take you to `https://www.cailinpitt.com`) and I always found them handy, especially for being able to easily link to long URLs. I always thought about writing my own shortlink service, but never found the time. I recently stumbled upon [this blog post](https://iamwillwang.com/notes/zohran-and-the-short-link/) from someone who wrote about the short links New York City's mayoral office uses for linking to different initiatives, and I decided it might be fun to finally build my own shortlink service.

I own `cailinpitt.com` but wanted a shorter domain to use for shortlinks, so I procured `cailin.link`. I then built a pretty lightweight shortlink service that uses two tables in a SQLite db to keep track of shortlink mappings and metrics – `links` holds the mappings (a slug like `/me` and destination like `https://www.cailinpitt.com`) and `clicks` holds basic link visit metrics (country of IP address that visited a link, user agent, click time). I then built a Cloudflare Worker responsible for taking requests to `cailin.link` and redirecting them to the correct destinations (or showing a 404 page if the shortlink doesn't exist). My goal with this project was to stay under Cloudflare's free tier limits, so I'm also using several indexes and caching to reduce DB load and keep things performant.

Since links are stored in a single table, it's pretty easy to create/read/update/delete links by writing queries to the database. However I also wanted to make it easy for me to configure links from my phone while on the go, so I built a simple authenticated admin view to do so and view click metrics. The admin page uses Cloudflare Access to handle authentication – I just log in with my email address and enter a One-time Password that Cloudflare emails to me.

<figure>
  <img src="/images/shortlinks/admin-view.webp" alt="Authenticated cailin.link admin view">
  <figcaption>Screenshot of the authenticated cailin.link admin view</a></figcaption>
</figure>

I knew how I wanted to design and implement my shortlink service, so I used Claude to automate some of the boilerplate tasks (setting up the Cloudflare resources, etc.). I'm pretty happy with how it turned out. The code is [here](https://github.com/cailinpitt/cailin.link) on GitHub.