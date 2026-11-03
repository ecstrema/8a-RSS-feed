import { parseHTML } from 'linkedom';
import { Feed } from '@numbered/feed';

const BASE_URL = 'https://www.8a.nu';
const CANDIDATE_URLS = [
  BASE_URL,
  `${BASE_URL}/news`,
  `${BASE_URL}/news/`,
  `${BASE_URL}/articles`,
  `${BASE_URL}/articles/`,
];

const LIST_SELECTORS = [
  '.news-list',
  '.news-feed',
  '.news-items',
  '.news-item-list',
  '.article-list',
  '.posts',
  '.post-list',
  '.featured-posts',
  '.latest-news',
  'article',
  '.news-item',
  '.article-item',
  '.post-card',
  '.article-card',
  '.news-card',
  '.entry',
];

const TITLE_SELECTORS = ['h1', 'h2', 'h3', '.title', '.entry-title', '.news-title', '.article-title'];
const DATE_SELECTORS = ['time', '[datetime]', '.date', '.published', '.news-date', '.article-date', '.meta time'];
const CONTENT_SELECTORS = [
  '.news-content',
  '.article-content',
  '.entry-content',
  '.post-content',
  '.content',
  'main .content',
  'main article',
  'article',
];
const DESC_SELECTORS = ['.summary', '.excerpt', '.teaser', '.description', '.lead', 'p'];

const feed = new Feed({
  title: '8a.nu news',
  description: '8a.nu climbing and vertical life news feed',
  id: BASE_URL,
  link: BASE_URL,
  language: 'en',
  image: `${BASE_URL}/favicon.png`,
  favicon: `${BASE_URL}/favicon.png`,
  copyright: 'All rights reserved, Vertical Life',
  updated: new Date(),
  generator: "Ecstrema's 8a.nu news feed generator",
  feedLinks: {
    rss: `${BASE_URL}/rss.xml`,
    json: `${BASE_URL}/feed.json`,
    atom: `${BASE_URL}/atom.xml`,
  },
  author: {
    name: 'ecstrema',
    email: 'remimarche@gmail.com',
    link: 'https://ecstrema.com',
  },
});

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function toAbsoluteUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  if (candidate.startsWith('//')) return `https:${candidate}`;
  if (candidate.startsWith('/')) return new URL(candidate, BASE_URL).toString();
  try {
    return new URL(candidate, BASE_URL).toString();
  } catch {
    return null;
  }
}

function parseDate(raw: string | null | undefined): Date {
  const value = cleanText(raw);
  if (!value) return new Date();

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const match = value.match(/(\d{4}-\d{2}-\d{2})/);
  if (match) return new Date(match[1]);

  return new Date();
}

function findFirstText(node: Element | null | undefined, selectors: string[]): string | null {
  if (!node) return null;

  for (const selector of selectors) {
    const match = node.querySelector(selector);
    const text = cleanText(match?.textContent ?? null);
    if (text) return text;
  }

  return null;
}

function selectBestImage(node: Element | null | undefined): string | undefined {
  if (!node) return undefined;

  const candidates = node.querySelectorAll('img[src]');
  for (const img of candidates) {
    const src = toAbsoluteUrl((img as HTMLImageElement).getAttribute('src') ?? img.getAttribute('data-src'));
    if (src) return src;
  }

  return undefined;
}

function extractDescription(node: Element | null | undefined): string | undefined {
  if (!node) return undefined;

  for (const selector of DESC_SELECTORS) {
    const match = node.querySelector(selector);
    if (match) {
      const text = cleanText(match.textContent ?? null);
      if (text) return text;
    }
  }

  const fullText = cleanText(node.textContent ?? null);
  return fullText.length > 0 ? fullText : undefined;
}

function extractJsonLdArticles(document: Document): Array<Record<string, any>> {
  const results: Array<Record<string, any>> = [];
  const seen = new Set<string>();

  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const typeValue = value['@type'];
    const types = Array.isArray(typeValue) ? typeValue : [typeValue];
    const normalizedTypes = types.map((type) => String(type).toLowerCase());
    const isArticleLike =
      normalizedTypes.some((type) => /article|news|blog|post|itemlist/.test(type)) ||
      value['headline'] ||
      value['name'] ||
      value['url'];

    if (isArticleLike && (value['url'] || value['headline'] || value['name'])) {
      const url = toAbsoluteUrl(value['url'] ?? value['mainEntityOfPage']?.['@id'] ?? value['mainEntityOfPage'] ?? null);
      const key = url ?? `${value['headline'] ?? value['name'] ?? ''}:${value['datePublished'] ?? ''}`;
      if (key && !seen.has(key)) {
        seen.add(key);
        results.push(value);
      }
    }

    for (const nested of Object.values(value)) visit(nested);
  };

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = script.textContent ?? '';
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      visit(parsed);
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
  }

  return results;
}

function normalizeCandidate(raw: Record<string, any>): Record<string, any> | null {
  const url = toAbsoluteUrl(raw['url'] ?? raw['mainEntityOfPage']?.['@id'] ?? raw['mainEntityOfPage'] ?? null);
  const title = cleanText(raw['headline'] ?? raw['name'] ?? raw['title'] ?? null);
  if (!url || !title) return null;

  const image = Array.isArray(raw['image'])
    ? toAbsoluteUrl(raw['image'][0]?.url ?? raw['image'][0] ?? null)
    : toAbsoluteUrl(raw['image']?.url ?? raw['image'] ?? null);

  return {
    url,
    title,
    date: raw['datePublished'] ?? raw['dateModified'] ?? raw['published'] ?? raw['date'],
    description: raw['description'] ?? raw['summary'] ?? raw['articleBody']?.slice(0, 220) ?? null,
    image,
  };
}

function appendFeedItem(url: string, title: string, description: string | undefined, image: string | undefined, published: Date) {
  const id = url;
  feed.addItem({
    title,
    id,
    link: url,
    description: description ?? title,
    image,
    date: published,
    content: description ?? title,
  });
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 8a-rss-feed/1.0; +https://github.com/ecstrema/8a-RSS-feed)' } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

async function collectArticleCandidatesFromPage(url: string): Promise<Array<Record<string, any>>> {
  const html = await fetchHtml(url);
  const { document } = parseHTML(html);

  const candidates: Array<Record<string, any>> = [];
  const seen = new Set<string>();

  for (const selector of LIST_SELECTORS) {
    const container = document.querySelector(selector);
    if (!container) continue;

    const items = container.querySelectorAll('a[href], article, .news-item, .article-item, .post-card, .article-card, .news-card');
    for (const item of items) {
      const anchor = item.closest('a[href]') ?? item.querySelector('a[href]');
      const href = toAbsoluteUrl(anchor?.getAttribute('href') ?? item.getAttribute('data-href') ?? null);
      if (!href) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const title = findFirstText(item, TITLE_SELECTORS) ?? cleanText(anchor?.textContent ?? null) ?? cleanText((item as Element).textContent ?? null);
      const dateText = findFirstText(item, DATE_SELECTORS) ?? findFirstText(anchor ?? item, DATE_SELECTORS);
      const description = extractDescription(item) ?? extractDescription(anchor ?? item);
      const image = selectBestImage(item) ?? selectBestImage(anchor ?? item);

      if (title) {
        candidates.push({
          url: href,
          title,
          date: dateText,
          description,
          image,
        });
      }
    }
  }

  for (const article of extractJsonLdArticles(document)) {
    const normalized = normalizeCandidate(article);
    if (!normalized) continue;
    if (seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    candidates.push(normalized);
  }

  return candidates;
}

async function loadArticleDetails(url: string): Promise<{ title: string; description?: string; image?: string; published: Date }> {
  const html = await fetchHtml(url);
  const { document } = parseHTML(html);

  const title =
    findFirstText(document.querySelector('article'), TITLE_SELECTORS) ??
    findFirstText(document.body, TITLE_SELECTORS) ??
    document.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
    document.title ||
    'Untitled article';

  const dateText =
    findFirstText(document.querySelector('article'), DATE_SELECTORS) ??
    findFirstText(document.body, DATE_SELECTORS) ??
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ??
    document.querySelector('meta[name="pubdate"]')?.getAttribute('content') ??
    null;

  const articleContent =
    document.querySelector('.news-content, .article-content, .entry-content, .post-content, main article, article') ??
    document.body;

  const description =
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
    extractDescription(articleContent) ??
    undefined;

  const image =
    selectBestImage(document.querySelector('article')) ??
    selectBestImage(document.body) ??
    document.querySelector('meta[property="og:image"]')?.getAttribute('content') ??
    undefined;

  return {
    title: cleanText(title),
    description: description ? cleanText(description) : undefined,
    image: image ? toAbsoluteUrl(image) ?? undefined : undefined,
    published: parseDate(dateText),
  };
}

async function index8aNews(): Promise<void> {
  const uniqueItems = new Map<string, { url: string; title: string; description?: string; image?: string; published: Date }>();

  for (const candidateUrl of CANDIDATE_URLS) {
    try {
      const items = await collectArticleCandidatesFromPage(candidateUrl);
      for (const item of items) {
        if (!item.url || !item.title) continue;
        if (!uniqueItems.has(item.url)) {
          uniqueItems.set(item.url, {
            url: item.url,
            title: cleanText(item.title),
            description: item.description ? cleanText(item.description) : undefined,
            image: item.image ? toAbsoluteUrl(item.image) ?? undefined : undefined,
            published: parseDate(item.date ?? null),
          });
        }
      }
    } catch (error) {
      console.warn(`Skipping ${candidateUrl}:`, error instanceof Error ? error.message : error);
    }
  }

  const articleList = Array.from(uniqueItems.values());
  if (articleList.length === 0) {
    throw new Error('No news articles were found on 8a.nu using the current structure.');
  }

  for (const item of articleList) {
    try {
      const details = await loadArticleDetails(item.url);
      const title = details.title || item.title;
      appendFeedItem(item.url, title, details.description ?? item.description, details.image ?? item.image, details.published);
    } catch (error) {
      console.warn(`Failed to resolve article details for ${item.url}:`, error instanceof Error ? error.message : error);
      appendFeedItem(item.url, item.title, item.description, item.image, item.published);
    }
  }

  if (feed.items.length === 0) {
    throw new Error('Feed generation produced zero items.');
  }

  await Bun.write('./dist/rss.xml', feed.rss2());
  await Bun.write('./dist/feed.json', feed.json1());
  await Bun.write('./dist/atom.xml', feed.atom1());

  console.log(`Indexed ${feed.items.length} 8a.nu news items into the feed.`);
}

const distDir = './dist';
await Bun.write(`${distDir}/.keep`, '');
await index8aNews();
