---
title: "re: I turned my RSS feeds into an e-ink newspaper to stop reading on my phone"
date: 2026-08-23
path: /blog/2026/8/23/reading-rss-feeds-on-my-xteink-x4
slug: reading-rss-feeds-on-my-xteink-x4
tags: ["Tech", "RSS", "e-ink", "Automation"]
description: "Automatically sending new RSS feed entries to my Xteink X4"
---
I'm 20 years late, but I _finally_ started using RSS this year as a way to keep track of the different blogs I like to read. I recently saw [this post](https://heyjonny.dev/posts/rss-to-eink-newspaper/) pop up on Hacker News, where the author Jonas [built and released a method](https://github.com/jonashonecker/feedpaper) of taking RSS feeds they subscribe to and reading them on their Xteink X4 (a small e-reader device) running [CrossPoint](https://crosspointreader.com/). I thought this was a really cool idea I loved to see, but I wanted to build my own spin of it for two reasons:

* I use the free version of [Reeder](https://reeder.app/) as my RSS reader instead of [Feedbin](https://feedbin.com/) (which the author uses). I also wasn't interested in paying for Feedbin, as I'm pretty tired of subscriptions these days and $70/year felt too steep for my purposes. I likely would have switched over to Feedbin if they had a one-time fee I could have paid
* I wanted to automate the process of getting the EPUB file on my Xteink X4 instead of having to copy the file over to the device manually

CrossPoint makes it really easy to wirelessly push EPUBs to the Xteink when it is connected to wifi. With the help of Claude [I built a simple approach in Python](https://github.com/cailinpitt/newspaper) to fetch RSS feeds I specify in a config file, grab all the entries published in the last N hours, turn them into an EPUB, and push them to my Xteink when it is connected to my WiFi home network. I simply named the project `newspaper` and I have it running in a docker container on my home server. In order to receive the EPUB on my Xteink, all I have to do is click two buttons to enter the WiFi File Transfer mode and my RSS feed entries appear on my device in a few seconds. It's a little less refined than Jonas' approach since my reading history isn't tracked (entries I read on a different device can still show up on my Xteink), but it works well for my purposes.

