---
title: "Chicago Transit Authority: Wrapped"
date: 2026-09-01
path: /blog/2026/9/1/chicago-transit-authority-wrapped
slug: chicago-transit-authority-wrapped
tags: ["Chicago", "Transportation", "Tech"]
description: "Building an unofficial wrapped experience for the CTA"
image: /images/chicago-transit-authority-wrapped/blue-line.webp
---
At the beginning of 2026, I found myself annoyed at the Chicago Transit Authority (CTA) for not having a yearly wrapped. Transit agencies in other cities like Washington DC [have it](https://metrorewind.com/), so why couldn't Chicago? My friends in DC get to easily brag on social media about the number of transit trips they take in a given year, so why can't I? I decided to try and figure out a way to grab my transit data in an automated fashion and generate yearly summary visuals for it. After a bit of trial and error I was able to build something that worked, and the [code is here](https://github.com/cailinpitt/cta-wrapped). I'm moving from Chicago this month so my 2026 data is complete and I'm sharing it now:

<figure>
  <div class="image-grid">
    <a href="/images/chicago-transit-authority-wrapped/2026-1-overview.webp"><img src="/images/chicago-transit-authority-wrapped/2026-1-overview.webp" alt="CTA Wrapped card — 2026 overview"></a>
    <a href="/images/chicago-transit-authority-wrapped/2026-2-rail.webp"><img src="/images/chicago-transit-authority-wrapped/2026-2-rail.webp" alt="CTA Wrapped card — rail"></a>
    <a href="/images/chicago-transit-authority-wrapped/2026-3-bus.webp"><img src="/images/chicago-transit-authority-wrapped/2026-3-bus.webp" alt="CTA Wrapped card — bus"></a>
    <a href="/images/chicago-transit-authority-wrapped/2026-4-time-of-day.webp"><img src="/images/chicago-transit-authority-wrapped/2026-4-time-of-day.webp" alt="CTA Wrapped card — time of day"></a>
    <a href="/images/chicago-transit-authority-wrapped/2026-5-day-of-week.webp"><img src="/images/chicago-transit-authority-wrapped/2026-5-day-of-week.webp" alt="CTA Wrapped card — day of week"></a>
    <a href="/images/chicago-transit-authority-wrapped/2026-6-personality.webp"><img src="/images/chicago-transit-authority-wrapped/2026-6-personality.webp" alt="CTA Wrapped card — rider personality"></a>
  </div>
  <figcaption>The six Wrapped cards. Tap any one for the full-size image.</figcaption>
</figure>

### Fetching my Ventra card usage

The CTA (along with Pace and Metra) all use Ventra, a transit fare system for the Chicago metro area. When paying for transit, you tap a Ventra card on a fare reader on the bus or at a train station. On the web you can visit [ventrachicago.com](https://www.ventrachicago.com/) to view recent usage of your Ventra card (up to your 100 most recent card transactions). I figured the easiest way to grab my data and do something with it would be writing a script that used my Ventra credentials to log into my account and fetch my usage data via the same APIs the website used.

When writing a script, figuring out how auth worked took some trial and error. The API that returns Ventra usage history wants two things: proof you're logged in, and an anti-forgery token. Neither is straightforward to get, and there's no `/login` endpoint that hands back an auth token. Ventra's site runs on ASP.NET Web Forms, so logging in means sending a form-encoded postback to the homepage with the framework's callback fields set alongside your credentials. What you get back is a set of session cookies, and those are what authenticate you from then on. The anti-forgery token was trickier, because no API returns it. It's a hidden input (`hdnRequestVerificationToken`) sitting in the page HTML, so you have to load your account page and regex it out of the source. Only then does the API call to fetch usage data go through, with the cookies and the token passed as headers. Once I figured this out, I set up a weekly cron entry on my home server that logged into my Ventra account, fetched my recent card usage, and appended it to a JSON file. Once I had my card usage I was able to write logic to do basic data analysis (ex. what day do I ride transit the most?), generate pretty visuals, and then have a script on my home server regularly email myself my weekly and monthly transit usage.

### Some random things I learned from my Ventra data

* Some station names in the data predate the CTA's 1993 adoption of a color naming system for rail lines, still carrying their old branch names. For example, the Blue Line's Oak Park station is called `Blue-OakPark_Congress` and the Pink Line's Polk station is called `Pink-Polk_Douglas`

* Ventra doesn't record bus stops. For rail taps Ventra records the line[^lines] and station (ex. Jarvis on the Red Line) but simply records the route for buses. It sort of makes sense buses are on the move, but it would have been neat if Ventra had a way to at least record the GPS coordinates of bus taps so I could have figured out a way to tie them to specific bus stops
* Bus taps occasionally have routes that are mislabeled as `0 Deadhead` or `CTA Bus Default`. I saw this happen with a few taps I made on the 72 bus route earlier in the year (and the buses I tapped on were definitely in service), so I'm guessing these were data quirks where the system couldn't determine what route the bus I was on belonged to

### In conclusion

Part of my hope in making this post is that it shows the CTA and Ventra that building an official wrapped feature would be really cool! I think it would be exciting and well received by transit users in Chicago. Also the day I am writing this post is September 1, 2026, which is also the same day the new [Northern Illinois Transit Authority officially begins](https://nita.illinois.gov/blog/2026/09/01/northern-illinois-transit-authority-begins-new-era-for-regional-transit) – maybe having a new regional transit authority with a mandate to better connect transit agencies in the region will somehow make it easier for a wrapped feature to be built (maybe even for Pace and Metra too) 🤞

At the very least, I hope other transit users will use this code to better keep track of their transit usage.

#### Author note

If anyone from the CTA or Ventra somehow stumbles upon this post: hi, I hope you're not mad that I figured out a way to export my own Ventra data. If you are, please get in touch with me and I can delete the code I wrote and redact the technical details from this post.

[^lines]: Sort of. Tapping at a rail station serving multiple lines either includes just one of the lines (ex. Fullerton is recorded as `Red-Fullerton` and doesn't mention the Brown or Purple lines) or just `Loop` (Adams/Wabash is recorded as `Loop-Adams/Wabash`).
