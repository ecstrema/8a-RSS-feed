# 8a.nu RSS Feed

> [!WARNING]
> **This project no longer works reliably and is archived.**
> 8a.nu is now behind anti-scraping protection (a Cloudflare bot challenge: "Just a moment… Enable JavaScript and cookies to continue"), so simple HTTP scraping no longer works. Most requests, especially from GitHub Actions runners, receive the challenge page instead of content.
> When a scrape is blocked, the build exits cleanly and republishes the last successful feed, so the feed below may be stale or no longer updated.
>
> Each run starts from the previously published feed and only adds articles that are new on https://www.8a.nu/news (one request in the common case), to keep traffic to 8a.nu minimal.

Do you miss [the 8a.nu news-feed](https://www.8a.nu/news/rss-news-feed-7778)? Do you want an RSS/Atom/JSON feed for [8a.nu / Vertical Life](https://8a.nu)?

This repo generates an RSS feed for 8a.nu's news section. The feed is updated twice a day (at 00:00 and 12:00 UTC).

## Usage

Copy these links into your favorite reader:

 - RSS: https://ecstrema.github.io/8a-RSS-feed/rss.xml
 - Atom: https://ecstrema.github.io/8a-RSS-feed/atom.xml
 - JSON: https://ecstrema.github.io/8a-RSS-feed/feed.json
