// 新闻工具 — 免费 RSS 源，无需 API Key
import { ToolRegistry } from '../registry';
import { logger } from '../../../logger';
import { formatNewsHeadlines, formatNewsSearch } from '../responseFormatter';

interface NewsItem {
  title: string;
  source: string;
  url: string;
  published?: string;
}

// 阶段一·模块1: 导出供 web-search-mcp 复用（多源实时新闻检索 / 24h·7d 时效过滤 / 多源对比去偏见）
export const NEWS_SOURCES: { name: string; url: string; category: string }[] = [
  // 国内综合
  { name: '36氪', url: 'https://36kr.com/feed', category: '科技' },
  { name: '少数派', url: 'https://sspai.com/feed', category: '科技' },
  { name: '虎嗅', url: 'https://www.huxiu.com/rss/0.xml', category: '商业' },
  { name: '爱范儿', url: 'https://www.ifanr.com/feed', category: '科技' },
  // 国际科技
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage', category: '科技' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: '科技' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: '科技' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: '科技' },
  // 综合新闻
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', category: '综合' },
  { name: 'Reuters', url: 'https://www.rss-bridge.org/bridge01/?action=display&bridge=FilterBridge&url=https%3A%2F%2Fwww.reuters.com&content_filter=&content_filter_type=text&title_filter=&title_filter_type=text&author_filter=&author_filter_type=text&uri_filter=&uri_filter_type=text&case_insensitive=on&fix_encoding=on&format=Atom', category: '综合' },
];

// Fallback categories when RSS parsing fails: use keyword-based search suggestions
const CATEGORY_KEYWORDS: Record<string, string> = {
  '科技': '科技 AI 人工智能',
  '商业': '商业 财经 经济',
  '综合': '今日要闻',
  '体育': '体育 赛事',
  '娱乐': '娱乐 影视',
};

async function fetchRSS(url: string): Promise<NewsItem[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MayOS/2.0 (News Reader)', 'Accept': 'application/rss+xml, application/xml, text/xml' },
    });
    if (!resp.ok) return [];
    const xml = await resp.text();

    const items: NewsItem[] = [];
    // Parse RSS <item> blocks
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRe.exec(xml)) !== null) {
      const block = match[1];
      const title = extractTag(block, 'title');
      const link = extractTag(block, 'link');
      const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
      if (title && link) {
        items.push({ title: decodeEntities(title), source: '', url: link, published: pubDate || undefined });
      }
    }
    return items.slice(0, 10);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x?[0-9a-fA-F]+;/g, '').replace(/&[a-z]+;/g, '');
}

async function newsHeadlines(args: Record<string, any>): Promise<string> {
  const category = String(args.category || '科技').trim();
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);

  const sources = NEWS_SOURCES.filter(s => s.category === category);
  const results = await fetchFromSources(sources.length > 0 ? sources : NEWS_SOURCES, limit);
  logger.info(`[News] headlines ${category} → ${results.length} items`);
  return formatNewsHeadlines({ category, items: results.slice(0, limit) });
}

// 阶段一·模块1: 导出供 web-search-mcp 复用（fetchRSS 由 web_search 模块独立实现可并发抓取更多源）
export async function fetchFromSources(sources: typeof NEWS_SOURCES, limit: number, fetchRSSImpl?: (url: string) => Promise<NewsItem[]>): Promise<NewsItem[]> {
  // Fetch up to 3 sources in parallel for speed
  const selected = sources.slice(0, 3);
  const fetcher = fetchRSSImpl || fetchRSS;
  const results = await Promise.all(selected.map(async s => {
    const items = await fetcher(s.url);
    return items.map(i => ({ ...i, source: s.name }));
  }));
  return results.flat().slice(0, limit);
}

async function newsSearch(args: Record<string, any>): Promise<string> {
  const keyword = String(args.keyword || '').trim();
  if (!keyword) throw new Error('keyword 参数不能为空');

  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
  const results = await fetchFromSources(NEWS_SOURCES, 30);
  const matched = results.filter(item =>
    item.title.toLowerCase().includes(keyword.toLowerCase())
  ).slice(0, limit);

  logger.info(`[News] search "${keyword}" → ${matched.length} items`);
  return formatNewsSearch({ keyword, items: matched });
}

export function registerNewsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'news_headlines',
    description:
      '获取最新新闻头条。支持按类别筛选：科技（36氪、少数派、Hacker News、TechCrunch等）、商业（虎嗅）、综合（BBC）。免费RSS源，无需API Key。如果需要搜索特定主题的新闻，使用 news_search。',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '新闻类别: "科技"、"商业"、"综合"。默认"科技"。' },
        limit: { type: 'number', description: '返回条数（1-20，默认8）' },
      },
      required: [],
    },
    handler: newsHeadlines,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'news_search',
    description:
      '按关键词搜索新闻标题。从多个RSS源中匹配标题包含关键词的新闻。适合查找特定话题的最新报道。对于更全面的搜索，可配合 web_search 使用。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，如"AI"、"苹果"、"美联储"' },
        limit: { type: 'number', description: '返回条数（1-20，默认8）' },
      },
      required: ['keyword'],
    },
    handler: newsSearch,
    permission: 'user',
    securityLevel: 'safe',
  });
}
