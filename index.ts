import { parseHTML } from 'linkedom';
import { Feed } from '@numbered/feed';

const BASE_URL = 'https://www.8a.nu';
const NEWS_URL = `${BASE_URL}/news`;
const IMAGE_CDN = 'https://d3byf4kaqtov0k.cloudfront.net/';

// Where the previously generated feed is published (GitHub Pages). Its items are
// reused, so each run only needs the news listing plus pages of genuinely new articles.
const PUBLISHED_FEED_URL = 'https://ecstrema.github.io/8a-RSS-feed';
const FEED_FILES = ['rss.xml', 'atom.xml', 'feed.json'];

// Keep the feed small: at most MAX_ITEMS, and each output file under MAX_FEED_BYTES
// (oldest items are dropped first).
const MAX_ITEMS = 50;
const MAX_FEED_BYTES = 512 * 1024;

// Be polite: few requests, spaced out.
const MAX_ARTICLE_FETCHES = 10; // article pages fetched per run (only for new items lacking content)
const REQUEST_DELAY_MS = 2000;
const USER_AGENT = 'Mozilla/5.0 (compatible; 8a-rss-feed/1.0; +https://github.com/ecstrema/8a-RSS-feed)';

const distDir = './dist';

type Item = {
  url: string;
  title: string;
  content: string; // HTML
  summary: string; // plain text
  published: Date;
};

type Listed = Item & { complete: boolean };

/** Thrown when 8a.nu answers with a Cloudflare challenge/block page or a rate limit. */
class BlockedError extends Error {}

// ---------------------------------------------------------------------------
// Helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toAbsoluteUrl(value: string | null | undefined, base = BASE_URL): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.startsWith('data:')) return undefined;
  try {
    return new URL(candidate, base).toString();
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

/**
 * Parses 8a.nu dates: the payload's "2026-11-18T11:05:00" (no zone given; it matches
 * UTC) or the page's "17 November 2026".
 */
function parseDate(raw: string | null | undefined): Date | undefined {
  const value = cleanText(raw);
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) return new Date(`${value}Z`);
  const match = value.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (match) {
    const month = MONTHS.indexOf(match[2].toLowerCase());
    if (month >= 0) return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function youtubeId(src: string | null | undefined): string | undefined {
  return src?.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/)?.[1];
}

/**
 * A YouTube player for feed readers. Readers that allow iframes (Feedly, Inoreader,
 * NetNewsWire, Miniflux, ...) play it inline; the others strip the iframe and show the
 * thumbnail, which links to the video.
 */
function youtubeEmbed(id: string): string {
  return [
    `<iframe width="560" height="315" src="https://www.youtube.com/embed/${id}" title="YouTube video" frameborder="0" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`,
    `<p><a href="https://www.youtube.com/watch?v=${id}"><img src="https://img.youtube.com/vi/${id}/hqdefault.jpg" alt="▶ Watch on YouTube" width="480" height="360"></a><br><a href="https://www.youtube.com/watch?v=${id}">▶ Watch on YouTube</a></p>`,
  ].join('\n');
}

function summarize(html: string, maxLength = 300): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const el of Array.from(document.querySelectorAll('br, p, div'))) el.after(' ');
  const text = cleanText(document.body.textContent);
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const sentenceEnd = cut.lastIndexOf('. ');
  return (sentenceEnd > maxLength / 2 ? cut.slice(0, sentenceEnd + 1) : `${cut.replace(/\s+\S*$/, '')}…`).trim();
}

/**
 * Builds readable, self-contained HTML for feed readers: the article image once at the
 * top (unless the body already shows it), the article body with absolute links, and
 * YouTube videos as playable embeds.
 */
function buildContent(bodyHtml: string, opts: { url: string; image?: string; videoId?: string }): string {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const body = document.body;

  for (const el of Array.from(body.querySelectorAll('[href]'))) {
    const href = toAbsoluteUrl(el.getAttribute('href'));
    if (href) el.setAttribute('href', href);
  }
  for (const el of Array.from(body.querySelectorAll('[src]'))) {
    const src = toAbsoluteUrl(el.getAttribute('src'));
    if (src) el.setAttribute('src', src);
  }

  // Replace YouTube iframes with a clean embed plus a thumbnail link fallback.
  const embedded = new Set<string>();
  for (const iframe of Array.from(body.querySelectorAll('iframe'))) {
    const id = youtubeId(iframe.getAttribute('src'));
    if (!id) continue;
    embedded.add(id);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = youtubeEmbed(id);
    iframe.replaceWith(wrapper);
  }

  const parts: string[] = [];
  const bodyImages = Array.from(body.querySelectorAll('img')).map((img) => img.getAttribute('src'));
  if (opts.image && !bodyImages.includes(opts.image)) {
    parts.push(`<p><img src="${escapeHtml(opts.image)}" alt="" style="max-width:100%;height:auto"></p>`);
  }
  parts.push(body.innerHTML.trim());
  if (opts.videoId && !embedded.has(opts.videoId)) parts.push(youtubeEmbed(opts.videoId));
  parts.push(`<p><a href="${escapeHtml(opts.url)}">Read on 8a.nu</a></p>`);
  return parts.filter(Boolean).join('\n');
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

// ---------------------------------------------------------------------------
// Parsing

/**
 * Decodes Nuxt's `__NUXT_DATA__` payload (devalue format: a flat array where objects
 * and arrays reference other entries by index).
 */
function decodeNuxtPayload(text: string): unknown {
  const table = JSON.parse(text) as unknown[];
  const cache = new Map<number, unknown>();
  const WRAPPERS = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef']);

  const revive = (index: number): unknown => {
    if (index === -1) return undefined;
    if (index < 0) return null; // holes, NaN, infinities: not needed here
    if (cache.has(index)) return cache.get(index);
    const value = table[index];
    if (Array.isArray(value)) {
      if (typeof value[0] === 'string' && WRAPPERS.has(value[0])) return revive(value[1] as number);
      if (value[0] === 'Date') return value[1];
      if (typeof value[0] === 'string' && /^(Set|Map|BigInt|RegExp|EmptyRef|EmptyShallowRef|null)$/.test(value[0])) return null;
      const out: unknown[] = [];
      cache.set(index, out);
      for (const ref of value) out.push(revive(ref as number));
      return out;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      cache.set(index, out);
      for (const [key, ref] of Object.entries(value)) out[key] = revive(ref as number);
      return out;
    }
    return value;
  };

  return revive(0);
}

/** All news records found in a page's payload ({slug, title, content, datePublished, images, ...}). */
function payloadNews(document: Document): Array<Record<string, any>> {
  const script = document.querySelector('script#__NUXT_DATA__');
  if (!script?.textContent) return [];

  let root: unknown;
  try {
    root = decodeNuxtPayload(script.textContent);
  } catch (error) {
    console.warn('Could not decode the Nuxt payload:', error instanceof Error ? error.message : error);
    return [];
  }

  const found: Array<Record<string, any>> = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 12) return;
    seen.add(value);
    const record = value as Record<string, any>;
    if (!Array.isArray(value) && typeof record.slug === 'string' && typeof record.title === 'string' && 'datePublished' in record) {
      found.push(record);
      return;
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(root, 0);
  return found;
}

function itemFromPayload(record: Record<string, any>): Listed | undefined {
  const url = toArticleUrl(`/news/${record.slug}`);
  const title = cleanText(record.title);
  if (!url || !title) return undefined;

  const content = typeof record.content === 'string' ? record.content : '';
  const fileName = Array.isArray(record.images) ? record.images.find((img: any) => img?.fileName)?.fileName : undefined;
  const image = toAbsoluteUrl(fileName, IMAGE_CDN);
  const videoId = youtubeId(record.videoId ? `https://www.youtube.com/embed/${record.videoId}` : undefined);

  return {
    url,
    title,
    content: buildContent(content, { url, image, videoId }),
    summary: summarize(content) || title,
    published: parseDate(record.datePublished) ?? new Date(),
    complete: content.trim().length > 0 && !!parseDate(record.datePublished),
  };
}

/** Fallback when the payload is missing: read the rendered listing markup. */
function itemsFromMarkup(document: Document): Listed[] {
  const items: Listed[] = [];
  for (const entry of Array.from(document.querySelectorAll('.news-list .news-item, .news-page-container > .news-item'))) {
    const titleLink = entry.querySelector('h1 a, h2 a, h3 a, h4 a') ?? entry.querySelector('a[href*="/news/"]');
    const url = toArticleUrl(titleLink?.getAttribute('href')) ?? toArticleUrl(document.querySelector('link[rel="canonical"]')?.getAttribute('href'));
    const title = cleanText(entry.querySelector('h1, h2, h3, h4')?.textContent ?? titleLink?.textContent);
    if (!url || !title) continue;

    const img = entry.querySelector('img.news-image');
    const image = toAbsoluteUrl(img?.getAttribute('src'));
    const content = entry.querySelector('.news-content')?.innerHTML ?? '';
    const videoId = youtubeId(entry.querySelector('.video-container iframe')?.getAttribute('src'));
    const date = parseDate(entry.querySelector('.news-item-topline')?.textContent);

    items.push({
      url,
      title,
      content: buildContent(content, { url, image, videoId }),
      summary: summarize(content) || title,
      published: date ?? new Date(),
      // The rendered listing truncates long articles ("…") and has no time of day.
      complete: false,
    });
  }
  return items;
}

function parseNewsPage(html: string): Listed[] {
  const { document } = parseHTML(html);
  const fromPayload = payloadNews(document).map(itemFromPayload).filter((item): item is Listed => !!item);
  const items = fromPayload.length > 0 ? fromPayload : itemsFromMarkup(document);

  const unique = new Map<string, Listed>();
  for (const item of items) if (!unique.has(item.url)) unique.set(item.url, item);
  return Array.from(unique.values());
}

/** Fetches an article page, for new listing entries that lacked content or a date. */
async function fetchArticle(listed: Listed): Promise<Item> {
  const items = parseNewsPage(await fetchHtml(listed.url));
  return items.find((item) => item.url === listed.url) ?? listed;
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
      // Skip entries produced by the first version of this script (site logo instead of the article image).
      if (!url || !raw.title || /\/images\/vl-logos\//.test(raw.image ?? '')) continue;
      items.push({
        url,
        title: raw.title,
        content: raw.content_html ?? raw.content_text ?? raw.title,
        summary: raw.summary ?? raw.title,
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

function renderFeed(items: Item[]): Record<string, string> {
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
    // No `image`: it would become an enclosure that readers show a second time below
    // the article. The image is already at the top of the content.
    feed.addItem({
      title: item.title,
      id: item.url,
      link: item.url,
      description: item.summary,
      content: item.content,
      date: item.published,
      published: item.published,
    });
  }

  return { 'rss.xml': feed.rss2(), 'atom.xml': feed.atom1(), 'feed.json': feed.json1() };
}

/** Writes the feeds, dropping the oldest items until every file fits MAX_FEED_BYTES. */
async function writeFeed(items: Item[]): Promise<number> {
  let kept = items.slice(0, MAX_ITEMS);
  let files = renderFeed(kept);
  const size = () => Math.max(...Object.values(files).map((text) => Buffer.byteLength(text)));
  while (kept.length > 1 && size() > MAX_FEED_BYTES) {
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.9)));
    files = renderFeed(kept);
  }
  for (const [name, text] of Object.entries(files)) await Bun.write(`${distDir}/${name}`, text);
  return kept.length;
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
  const items = new Map(previous.map((item) => [item.url, item]));

  const listed = parseNewsPage(await fetchHtml(NEWS_URL));
  if (listed.length === 0) {
    throw new Error('No news articles were found on 8a.nu using the current structure.');
  }
  const fresh = listed.filter((item) => !items.has(item.url));
  console.log(`Found ${listed.length} articles on ${NEWS_URL}, ${fresh.length} new.`);

  // Articles still on the listing are refreshed from it (no extra request). Only new
  // articles with missing content or date get their own page fetched.
  let fetches = 0;
  for (const item of listed) {
    let resolved: Item = item;
    if (!item.complete && !items.has(item.url) && fetches < MAX_ARTICLE_FETCHES) {
      fetches++;
      try {
        resolved = await fetchArticle(item);
      } catch (error) {
        console.warn(`Using listing data for ${item.url}:`, error instanceof Error ? error.message : error);
        if (error instanceof BlockedError) fetches = MAX_ARTICLE_FETCHES; // stop fetching
      }
    } else if (!item.complete && items.has(item.url)) {
      continue; // keep the previously published (complete) version
    }
    const { complete, ...clean } = resolved as Listed;
    items.set(clean.url, clean);
  }

  const sorted = Array.from(items.values()).sort((a, b) => b.published.getTime() - a.published.getTime());
  const written = await writeFeed(sorted);
  console.log(`Wrote ${written} items (${fresh.length} new, ${fetches} article pages fetched).`);
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
