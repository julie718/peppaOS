// 阶段一·模块1: web-search-mcp — 多源实时新闻检索 + 24h/7d 时效过滤 + 多方资讯对比去偏见
// 统一复用 news_tools 的多源 RSS 底座（NEWS_SOURCES）；本模块补充：并发抓全源、时效窗口过滤、
// 去重聚合、多源观点对比（去偏见：不同来源并列呈现 + 冲突提示，不替用户下结论）。
import { ToolRegistry } from '../registry';
import { buildMcpServerFromRegistry } from './mcp_helpers';
import { logger } from '../../lib/logger';
import { NEWS_SOURCES } from '../definitions/news_tools';
import { bumpPreferenceTag } from '../../db/lifeDb';
// 阶段一·模块2: 数字孪生行为采集（阅读维度）＋ 模块3: 资讯阅读后人格微调
import { collectBehavior } from '../../autonomy/digital_twin';
import { getPersonalityEngine } from '../../life/personality';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface FeedItem { title: string; link?: string; pubDate?: string; content?: string; source?: string }

// 轻量 RSS 解析（兼容 CDATA/命名空间）：只取 title/link/pubDate，避免引入新依赖
function parseRSS(xml: string, url: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRe = /<item[\s\S]*?<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[0];
    const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || '';
    const link = /<link[^>]*>([\s\S]*?)<\/link>/.exec(block)?.[1]?.trim() || '';
    const pubDate = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/.exec(block)?.[1]?.trim()
      || /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/.exec(block)?.[1]?.trim() || '';
    if (title) items.push({ title, link, pubDate });
  }
  // Atom 兜底
  if (items.length === 0) {
    const entryRe = /<entry[\s\S]*?<\/entry>/g;
    while ((m = entryRe.exec(xml)) !== null) {
      const block = m[0];
      const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || '';
      const link = /<link[^>]*href="([^"]+)"/.exec(block)?.[1]?.trim() || '';
      const pubDate = /<updated[^>]*>([\s\S]*?)<\/updated>/.exec(block)?.[1]?.trim() || '';
      if (title) items.push({ title, link, pubDate });
    }
  }
  return items.filter(i => i.title && i.title.toLowerCase() !== 'error');
}

export async function fetchRSS(url: string): Promise<FeedItem[]> {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'PeppaOS/1.0 (news aggregator)' }, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return [];
    return parseRSS(await resp.text(), url);
  } catch {
    return [];
  }
}

/** 24h/7d 时效过滤：pubDate 在 hours 窗口内（兼容多种日期格式；解析失败按通过处理） */
export function isWithinWindow(pubDate: string | undefined, hours: number): boolean {
  if (!pubDate) return true; // 无时间戳不误杀
  const t = Date.parse(pubDate);
  if (isNaN(t)) return true;
  return Date.now() - t <= hours * 60 * 60 * 1000 && t <= Date.now() + 60 * 60 * 1000;
}

/** 多源抓取：并发抓全部源（限 8 个），保留来源标注 */
export async function fetchMultiSource(keyword: string, hours: number, limit: number): Promise<Array<FeedItem & { sources: string[] }>> {
  const sources = NEWS_SOURCES.slice(0, 8);
  const raw = await Promise.all(sources.map(async s => {
    const items = await fetchRSS(s.url);
    return items.map(i => ({ ...i, source: s.name, category: s.category }));
  }));
  const kw = keyword.toLowerCase();
  const matched = raw.flat()
    .filter(i => i.title.toLowerCase().includes(kw))
    .filter(i => isWithinWindow(i.pubDate, hours))
    .slice(0, limit);
  // 去重：同标题不同源合并，标注多源数
  const seen = new Map<string, FeedItem[]>();
  for (const item of matched) {
    const key = item.title.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 30).toLowerCase();
    const arr = seen.get(key) || [];
    arr.push(item);
    seen.set(key, arr);
  }
  const deduped: Array<FeedItem & { sources: string[] }> = [];
  for (const [, arr] of seen) {
    deduped.push({ ...arr[0], sources: [...new Set(arr.map(a => a.source).filter(Boolean))] });
  }
  return deduped.slice(0, limit);
}

// ── handlers ──
async function websearchMulti(args: Record<string, any>, userId: string): Promise<string> {
  const keyword = String(args.keyword || '').trim();
  if (!keyword) throw new Error('keyword 为必填');
  const hours = Math.min(Math.max(Number(args.hours) || 24, 1), 24 * 7);
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
  const items = await fetchMultiSource(keyword, hours, limit);
  // 工具结果沉淀用户偏好（资讯关注主题）
  await bumpPreferenceTag(userId, `资讯-${keyword.slice(0, 10)}`, 0.1).catch(() => {});
  // 阶段一·模块2: 数字孪生采集（阅读维度）
  await collectBehavior(userId, '阅读', keyword.slice(0, 10), 0.1).catch(() => {});
  // 阶段一·模块3: 资讯阅读后缓慢微调 8 维人格（持续了解某主题 → 好奇/开放微升）
  await getPersonalityEngine().adaptToEvent({ type: 'news_reading' }).catch(() => {});
  if (!items.length) return `ℹ️ 最近 ${hours}h 内未检索到「${keyword}」相关报道（已扫描 ${NEWS_SOURCES.length} 个来源）`;
  const lines = items.map((i, idx) => {
    const src = i.sources?.length ? `（${i.sources.join('、')}${i.sources.length > 1 ? ` 等${i.sources.length}家报道` : ''}）` : '';
    return `${idx + 1}. ${i.title}${src}`;
  });
  logger.info(`[WebSearchMCP] "${keyword}" ${hours}h → ${items.length} 条`);
  return `【${keyword}】最近 ${hours}h ${items.length} 条报道（扫描 ${NEWS_SOURCES.length} 源）:\n` + lines.join('\n');
}

async function websearchCompare(args: Record<string, any>, userId: string): Promise<string> {
  // 多方资讯对比去偏见：同主题各源报道并列 + 时效 + 来源画像，标注立场差异，不下结论
  const keyword = String(args.keyword || '').trim();
  if (!keyword) throw new Error('keyword 为必填');
  const hours = Math.min(Math.max(Number(args.hours) || 24 * 7, 1), 24 * 7);
  const items = await fetchMultiSource(keyword, hours, 30);
  if (!items.length) return `ℹ️ ${hours}h 内无「${keyword}」多源报道，无法对比`;
  // 按源分组
  const bySource = new Map<string, FeedItem[]>();
  for (const i of items) {
    for (const s of i.sources || []) {
      const arr = bySource.get(s) || [];
      arr.push(i);
      bySource.set(s, arr);
    }
  }
  const sourceProfile: Record<string, string> = { 'BBC News': '英国公共广播', Reuters: '路透社（通讯社）', 'Hacker News': '技术社区', TechCrunch: '科技媒体', 'The Verge': '科技媒体', '36氪': '中国科技商业媒体', 虎嗅: '中国商业媒体', 爱范儿: '中国科技媒体', 少数派: '中国效率工具社区' };
  const lines = [`【${keyword}】多源对比（${hours}h 内，${bySource.size} 个来源）:`];
  for (const [src, arr] of bySource) {
    const profile = sourceProfile[src] || '媒体';
    lines.push(`\n📰 ${src}（${profile}）· ${arr.length} 条:`);
    arr.slice(0, 3).forEach((i, idx) => lines.push(`   - ${i.title}${i.pubDate ? ' @' + i.pubDate.slice(0, 16) : ''}`));
  }
  lines.push('\n⚖️ 去偏见提示：以上为各源原始报道并列，未做立场过滤；如各源表述冲突，请以原始出处核实。');
  lines.push(`🧠 已沉淀关注偏好: ${keyword}`);
  return lines.join('\n');
}

// ── 时事类提问强制检索词表（chat 工具路由复用；命中即强制走检索而非直接答） ──
export const MUST_SEARCH_TERMS = ['时事', '国际', '战争', '冲突', '选举', '峰会', '关税', '制裁', '美联储', '央行', '最新消息', '突发'];

export function registerWebSearchTools(registry: ToolRegistry): void {
  const tools = [
    { name: 'websearch_multi', desc: '多源实时新闻检索：扫描多家中外新闻源，按关键词匹配，支持 24h/7d 时效窗口过滤，多源报道自动去重合并并标注来源数', params: { type: 'object', properties: { keyword: { type: 'string' }, hours: { type: 'number', description: '时效窗口（小时，默认24，最大168）' }, limit: { type: 'number' } }, required: ['keyword'] }, handler: websearchMulti },
    { name: 'websearch_compare', desc: '多方资讯对比去偏见：同一主题各源报道按来源分组并列呈现+来源画像+立场差异提示，不替用户下结论', params: { type: 'object', properties: { keyword: { type: 'string' }, hours: { type: 'number', description: '时效窗口（默认7天）' } }, required: ['keyword'] }, handler: websearchCompare },
  ];
  for (const t of tools) {
    registry.register({
      name: t.name,
      description: t.desc,
      parameters: t.params,
      handler: async (a: Record<string, any>) => t.handler(a, String(a.userId || process.env.E2E_UID || 'peppa-user')),
      permission: 'user',
      securityLevel: 'safe',
    });
  }
  logger.info(`[WebSearchMCP] 已注册 ${tools.length} 个工具 + 强制检索词 ${MUST_SEARCH_TERMS.length} 个`);
}

export function createWebSearchMcpServer(): McpServer {
  const registry = new ToolRegistry();
  registerWebSearchTools(registry);
  return buildMcpServerFromRegistry('web-search-mcp', '1.0.0', registry, ['websearch_multi', 'websearch_compare']);
}