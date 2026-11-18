import { parseHTML } from 'linkedom';
import { Feed } from '@numbered/feed';

const BASE_URL = 'https://www.8a.nu';
const NEWS_URL = `${BASE_URL}/news`;

// Where the previously generated feed is published (GitHub Pages). Its items are
// reused, so each run only needs the news listing plus pages of genuinely new articles.
const PUBLISHED_FEED_URL = 'https://ecstrema.github.io/8a-RSS-feed';
const FEED_FILES = ['rss.xml', 'atom.xml', 'feed.json'];

// Be polite: few requests, spaced out.
const MAX_ITEMS = 100; // items kept in the feed
const MAX_ARTICLE_FETCHES = 10; // article pages fetched per run (only for new items lacking content)
const REQUEST_DELAY_MS = 2000;
const USER_AGENT = 'Mozilla/5.0 (compatible; 8a-rss-feed/1.0; +https://github.com/ecstrema/8a-RSS-feed)';

const distDir = './dist';

type Item = {
  url: string;
  title: string;
  content: string; // HTML
  summary: string; // plain text
  image?: string;
  published: Date;
};

/** Thrown when 8a.nu answers with a Cloudflare challenge/block page or a rate limit. */
class BlockedError extends Error {}

// ---------------------------------------------------------------------------
// Helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function toAbsoluteUrl(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.startsWith('data:')) return undefined;
  try {
    return new URL(candidate, BASE_URL).toString();
  } catch {
    return undefined;
  }
}

/** Canonical article URL, or undefined if it is not a news article (e.g. /news/some-slug). */
function toArticleUrl(href: string | null | undefined): string | undefined {
  const absolute = toAbsoluteUrl(href);
  if (!absolute) return undefined;
  const url = new URL(absolute);
  if (!/(^|\.)8a\.nu$/.test(url.hostname) || !/^\/news\/[^/]+\/?$/.test(url.pathname)) return undefined;
  url.hash = ''; // drop "#comments" etc.
  url.search = '';
  return url.toString();
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Parses 8a.nu's "17 November 2026" (or any ISO date). */
function parseDate(raw: string | null | undefined): Date | undefined {
  const value = cleanText(raw);
  const match = value.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (match) {
    const month = MONTHS.indexOf(match[2].toLowerCase());
    if (month >= 0) return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  }
  const parsed = new Date(value);
  return value && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
}

function firstImage(node: Element | null | undefined): string | undefined {
  if (!node) return undefined;
  for (const img of Array.from(node.querySelectorAll('img.news-image, img'))) {
    const src =
      toAbsoluteUrl(img.getAttribute('src')) ??
      toAbsoluteUrl(img.getAttribute('data-src')) ??
      toAbsoluteUrl(img.getAttribute('srcset')?.split(/[\s,]+/)[0]);
    if (src && !/\/images\/vl-logos\//.test(src)) return src; // never the site logo
  }
  return undefined;
}

function youtubeThumbnail(embedSrc: string | undefined): string | undefined {
  const id = embedSrc?.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]+)/)?.[1];
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : undefined;
}

function summarize(html: string, maxLength = 300): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const br of Array.from(document.querySelectorAll('br'))) br.replaceWith(' ');
  const text = cleanText(document.body.textContent);
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const sentenceEnd = cut.lastIndexOf('. ');
  return (sentenceEnd > maxLength / 2 ? cut.slice(0, sentenceEnd + 1) : `${cut.replace(/\s+\S*$/, '')}…`).trim();
}

/** Turns a `.news-content` element into readable, self-contained HTML for feed readers. */
function buildContent(newsContent: Element | null | undefined, image: string | undefined, videoSrc: string | undefined, url: string): string {
  const parts: string[] = [];

  if (image) parts.push(`<p><img src="${image}" alt="" style="max-width:100%;height:auto"></p>`);

  if (newsContent) {
    // Make links and media absolute so they work outside 8a.nu.
    for (const el of Array.from(newsContent.querySelectorAll('[href]'))) {
      const href = toAbsoluteUrl(el.getAttribute('href'));
      if (href) el.setAttribute('href', href);
    }
    for (const el of Array.from(newsContent.querySelectorAll('[src]'))) {
      const src = toAbsoluteUrl(el.getAttribute('src'));
      if (src) el.setAttribute('src', src);
    }
    // Many readers strip iframes: add a plain link next to each embedded video.
    for (const iframe of Array.from(newsContent.querySelectorAll('iframe[src]'))) {
      const src = iframe.getAttribute('src')!;
      const link = newsContent.ownerDocument.createElement('p');
      link.innerHTML = `<a href="${src.replace('/embed/', '/watch?v=').replace(/\?si=.*$/, '')}">▶ Watch the video</a>`;
      iframe.after(link);
    }
    parts.push(newsContent.innerHTML.trim());
  }

  if (videoSrc && !parts.some((part) => part.includes(videoSrc))) {
    parts.push(`<p><a href="${videoSrc}">▶ Watch the video</a></p>`);
  }

  parts.push(`<p><a href="${url}">Read on 8a.nu</a></p>`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Fetching

let requestCount = 0;

async function fetchHtml(url: string): Promise<string> {
  if (requestCount++ > 0) await sleep(REQUEST_DELAY_MS);

  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  const body = await response.text();

  const blocked =
    response.status === 429 ||
    response.headers.get('cf-mitigated') === 'challenge' ||
    /<title>(Just a moment\.\.\.|Attention Required! \| Cloudflare)/i.test(body);
  if (blocked) {
    throw new BlockedError(`Blocked by 8a.nu anti-scraping protection on ${url} (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return body;
}

/** Parses the /news listing. Each entry already carries title, date, image and content. */
function parseNewsList(html: string): Array<Item & { hasContent: boolean }> {
  const { document } = parseHTML(html);
  const items: Array<Item & { hasContent: boolean }> = [];
  const seen = new Set<string>();

  for (const entry of Array.from(document.querySelectorAll('.news-list .news-item'))) {
    const titleLink = entry.querySelector('h1 a, h2 a, h3 a, h4 a') ?? entry.querySelector('a[href*="/news/"]');
    const url = toArticleUrl(titleLink?.getAttribute('href'));
    const title = cleanText(entry.querySelector('h1, h2, h3, h4')?.textContent ?? titleLink?.textContent);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);

    const newsContent = entry.querySelector('.news-content');
    const videoSrc = toAbsoluteUrl(entry.querySelector('.video-container iframe, .news-content iframe')?.getAttribute('src'));
    const image = firstImage(entry.querySelector('.news-image-container') ?? entry) ?? youtubeThumbnail(videoSrc);
    const summary = summarize(newsContent?.innerHTML ?? '') || title; // before buildContent mutates it
    const content = buildContent(newsContent, image, videoSrc, url);

    items.push({
      url,
      title,
      content,
      summary,
      image,
      published: parseDate(entry.querySelector('.news-item-topline')?.textContent) ?? new Date(),
      hasContent: cleanText(newsContent?.textContent).length > 0 || !!newsContent?.querySelector('iframe, img'),
    });
  }

  return items;
}

/** Fetches an article page, for new listing entries whose content was empty. */
async function fetchArticle(listed: Item): Promise<Item> {
  const { document } = parseHTML(await fetchHtml(listed.url));
  const article = document.querySelector('.news-page-container .news-item');
  if (!article) return listed;

  const newsContent = article.querySelector('.news-content');
  const image = firstImage(article) ?? listed.image;
  const summary = summarize(newsContent?.innerHTML ?? '') || listed.summary;
  return {
    url: listed.url,
    title: cleanText(article.querySelector('h1')?.textContent) || listed.title,
    content: buildContent(newsContent, image, undefined, listed.url),
    summary,
    image,
    published: parseDate(article.querySelector('.news-item-topline')?.textContent) ?? listed.published,
  };
}

/** Items from the feed published by the previous run (JSON Feed 1.0). */
async function loadPreviousItems(): Promise<Item[]> {
  try {
    const response = await fetch(`${PUBLISHED_FEED_URL}/feed.json`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const json = (await response.json()) as { items?: Array<Record<string, any>> };

    const items: Item[] = [];
    for (const raw of json.items ?? []) {
      const url = toArticleUrl(raw.url ?? raw.id);
      // Skip entries produced by older versions of this script (site logo instead of the
      // article image): they get rebuilt from the listing if still present there.
      if (!url || !raw.title || /\/images\/vl-logos\//.test(raw.image ?? '')) continue;
      items.push({
        url,
        title: raw.title,
        content: raw.content_html ?? raw.content_text ?? raw.title,
        summary: raw.summary ?? raw.title,
        image: raw.image,
        published: new Date(raw.date_published ?? raw.date_modified ?? Date.now()),
      });
    }
    console.log(`Loaded ${items.length} items from the previously published feed.`);
    return items;
  } catch (error) {
    console.warn('Could not load the previously published feed, starting fresh:', error instanceof Error ? error.message : error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Output

async function writeFeed(items: Item[]): Promise<void> {
  const feed = new Feed({
    title: '8a.nu news',
    description: '8a.nu climbing and vertical life news feed',
    id: BASE_URL,
    link: NEWS_URL,
    language: 'en',
    image: `${BASE_URL}/favicon.png`,
    favicon: `${BASE_URL}/favicon.png`,
    copyright: 'All rights reserved, Vertical Life',
    updated: items[0]?.published ?? new Date(),
    generator: "Ecstrema's 8a.nu news feed generator",
    feedLinks: {
      rss: `${PUBLISHED_FEED_URL}/rss.xml`,
      json: `${PUBLISHED_FEED_URL}/feed.json`,
      atom: `${PUBLISHED_FEED_URL}/atom.xml`,
    },
    author: {
      name: 'ecstrema',
      email: 'remimarche@gmail.com',
      link: 'https://ecstrema.com',
    },
  });

  for (const item of items) {
    feed.addItem({
      title: item.title,
      id: item.url,
      link: item.url,
      description: item.summary,
      content: item.content,
      image: item.image,
      date: item.published,
      published: item.published,
    });
  }

  await Bun.write(`${distDir}/rss.xml`, feed.rss2());
  await Bun.write(`${distDir}/feed.json`, feed.json1());
  await Bun.write(`${distDir}/atom.xml`, feed.atom1());
}

/** Re-publish the last deployed feed files untouched. */
async function restorePublishedFeed(): Promise<boolean> {
  try {
    for (const file of FEED_FILES) {
      const response = await fetch(`${PUBLISHED_FEED_URL}/${file}`);
      if (!response.ok) throw new Error(`${file}: ${response.status} ${response.statusText}`);
      await Bun.write(`${distDir}/${file}`, await response.text());
    }
    return true;
  } catch (error) {
    console.warn('Could not restore the previously published feed:', error instanceof Error ? error.message : error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  const previous = await loadPreviousItems();
  const known = new Map(previous.map((item) => [item.url, item]));

  const listed = parseNewsList(await fetchHtml(NEWS_URL));
  if (listed.length === 0) {
    throw new Error('No news articles were found on 8a.nu using the current structure.');
  }

  const fresh = listed.filter((item) => !known.has(item.url));
  console.log(`Found ${listed.length} articles on ${NEWS_URL}, ${fresh.length} new.`);

  let fetches = 0;
  for (const item of fresh) {
    let resolved: Item = item;
    if (!item.hasContent && fetches < MAX_ARTICLE_FETCHES) {
      fetches++;
      try {
        resolved = await fetchArticle(item);
      } catch (error) {
        console.warn(`Using listing data for ${item.url}:`, error instanceof Error ? error.message : error);
        if (error instanceof BlockedError) fetches = MAX_ARTICLE_FETCHES; // stop fetching
      }
    }
    const { hasContent, ...clean } = resolved as Item & { hasContent?: boolean };
    known.set(clean.url, clean);
  }

  const items = Array.from(known.values())
    .sort((a, b) => b.published.getTime() - a.published.getTime())
    .slice(0, MAX_ITEMS);

  await writeFeed(items);
  console.log(`Wrote ${items.length} items (${fresh.length} new, ${fetches} article pages fetched).`);
}

await Bun.write(`${distDir}/.keep`, '');

try {
  await main();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  const restored = await restorePublishedFeed();
  if (!restored) await writeFeed([]); // Nothing to fall back on: publish a valid, empty feed.
  // GitHub Actions annotation, so the stale feed is visible without failing the build.
  console.log(`::warning title=8a.nu scrape failed::${reason} — ${restored ? 'kept the previously published feed' : 'published an empty feed'}.`);
}
