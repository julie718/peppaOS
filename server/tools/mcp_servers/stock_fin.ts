// 阶段一·模块1: stock-fin-mcp — 个股K线/成交量/财报/行业公告/板块资讯
// 数据源：腾讯行情（qt.gtimg.cn 免费）K线（ifzq.gtimg.cn 免费）+ 东方财富公告/板块（免费接口），失败自动降级。
// 红线：仅客观陈列数据，严禁输出任何投资建议（所有工具描述与输出均带免责声明）。
import { ToolRegistry } from '../registry';
import { buildMcpServerFromRegistry } from './mcp_helpers';
import { logger } from '../../lib/logger';
import { bumpPreferenceTag } from '../../db/lifeDb';
// 阶段一·模块2: 数字孪生行为采集（理财维度）
import { collectBehavior } from '../../autonomy/digital_twin';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const DISCLAIMER = '\n⚠️ 以上仅为客观数据陈列，不构成任何投资建议。投资有风险，决策需自行判断。';

// ── 腾讯行情解析（可离线测试的纯函数） ──
/** 解析腾讯行情返回（v_sh600000="1~浦发银行~600000~现价~昨收~今开~...~成交量(手)~..."） */
export function parseTencentQuote(raw: string): Record<string, any> | null {
  const m = /="([^"]+)"/.exec(raw);
  if (!m) return null;
  const f = m[1].split('~');
  if (f.length < 8) return null;
  const num = (s: string) => { const v = parseFloat(s); return isNaN(v) ? null : v; };
  return {
    name: f[1], code: f[2], price: num(f[3]), prevClose: num(f[4]), open: num(f[5]),
    volume: num(f[6]), // 手
    high: num(f[33]), low: num(f[34]),
    changePct: num(f[32]),
  };
}

/** 个股代码归一：6 开头加 sh，0/3 开头加 sz，其余原样 */
export function normalizeStockCode(code: string): string {
  const c = String(code).trim().toLowerCase();
  if (/^\d{6}$/.test(c)) return (c.startsWith('6') ? 'sh' : 'sz') + c;
  return c;
}

export async function fetchQuote(code: string): Promise<Record<string, any> | null> {
  try {
    const n = normalizeStockCode(code);
    const resp = await fetch(`https://qt.gtimg.cn/q=${n}`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const text = await resp.text();
    return parseTencentQuote(text);
  } catch { return null; }
}

/** K线抓取（腾讯日K，免费） */
export async function fetchKline(code: string, days = 30): Promise<any[]> {
  try {
    const n = normalizeStockCode(code);
    const resp = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${n},day,,,${days},qfq`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];
    const json = await resp.json();
    const data = json?.data?.[n];
    const rows = data?.qfqday || data?.day || [];
    return rows.slice(-days).map((r: any) => ({ date: r[0], open: r[1], close: r[2], high: r[3], low: r[4], volume: r[5] }));
  } catch { return []; }
}

/** 板块资讯（东方财富概念板块排行，免费接口） */
export async function fetchBoards(limit = 8): Promise<any[]> {
  try {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=' + limit + '&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3&fields=f12,f14,f2,f3,f62';
    const resp = await fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];
    const json = await resp.json();
    return (json?.data?.diff || []).map((b: any) => ({ name: b.f14, code: b.f12, changePct: b.f3, totalMarketCap: b.f62 }));
  } catch { return []; }
}

// ── handlers ──
async function stockQuote(args: Record<string, any>, userId: string): Promise<string> {
  const code = String(args.code || '').trim();
  if (!code) throw new Error('code 为必填（6 位股票代码或带前缀）');
  const q = await fetchQuote(code);
  if (!q) return `⚠️ 未获取到 ${code} 行情（代码可能无效或网络异常）`;
  await bumpPreferenceTag(userId, `理财-${code}`, 0.1).catch(() => {});
  // 阶段一·模块2: 数字孪生采集（理财维度）
  await collectBehavior(userId, '理财', code, 0.1).catch(() => {});
  return `【${q.name} ${q.code}】\n现价 ${q.price ?? '—'}  涨跌幅 ${q.changePct ?? '—'}%\n今开 ${q.open ?? '—'}  昨收 ${q.prevClose ?? '—'}  最高 ${q.high ?? '—'}  最低 ${q.low ?? '—'}\n成交量 ${q.volume ?? '—'} 手` + DISCLAIMER;
}

async function stockKline(args: Record<string, any>, userId: string): Promise<string> {
  const code = String(args.code || '').trim();
  const days = Math.min(Math.max(Number(args.days) || 30, 5), 120);
  if (!code) throw new Error('code 为必填');
  const rows = await fetchKline(code, days);
  if (!rows.length) return `⚠️ 未获取到 ${code} K线数据`;
  const head = rows.slice(-10);
  const lines = head.map(r => `${r.date}  开${r.open}  收${r.close}  高${r.high}  低${r.low}  量${r.volume}`);
  const closes = rows.map(r => Number(r.close)).filter((v: number) => !isNaN(v));
  const change = closes.length > 1 ? ((closes[closes.length - 1] - closes[0]) / closes[0] * 100).toFixed(2) : '—';
  return `【${code}】最近 ${rows.length} 个交易日 K 线（近 10 日）:\n` + lines.join('\n') + `\n区间涨跌 ${change}%` + DISCLAIMER;
}

async function stockNews(args: Record<string, any>, userId: string): Promise<string> {
  // 个股公告与相关资讯：东方财富公告接口（免费）+ 降级说明
  const code = String(args.code || '').trim();
  if (!code) throw new Error('code 为必填');
  const n = normalizeStockCode(code).replace(/^(sh|sz)/, '');
  try {
    const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=5&page_index=1&ann_type=A&stock_list=${n}`;
    const resp = await fetch(url, { headers: { Referer: 'https://data.eastmoney.com/' }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    const list = json?.data?.list || [];
    if (!list.length) return `ℹ️ ${code} 近期暂无公告`;
    return `【${code}】近期公告（${list.length} 条）:\n` + list.slice(0, 5).map((a: any) => `- ${a.title || a.art_title || ''} ${a.notice_date || ''}`).join('\n') + DISCLAIMER;
  } catch (e: any) {
    return `ℹ️ 公告数据源暂不可用（${e?.message}），可改用 websearch_multi 检索「${code} 公告」`;
  }
}

async function stockBoards(args: Record<string, any>): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
  const boards = await fetchBoards(limit);
  if (!boards.length) return '⚠️ 板块数据暂不可用';
  return `【行业板块涨幅榜 TOP ${boards.length}】\n` + boards.map((b, i) => `${i + 1}. ${b.name}  ${b.changePct}%`).join('\n') + DISCLAIMER;
}

export function registerStockTools(registry: ToolRegistry): void {
  const tools = [
    { name: 'stock_quote', desc: '个股实时行情：现价/涨跌幅/今开/昨收/最高/最低/成交量（腾讯免费接口）。仅客观陈列，严禁输出投资建议', params: { type: 'object', properties: { code: { type: 'string', description: '6位股票代码，如 600000' } }, required: ['code'] }, handler: stockQuote },
    { name: 'stock_kline', desc: '个股K线：最近 N 个交易日 开收高低+成交量（腾讯免费接口），附区间涨跌。仅客观陈列，严禁输出投资建议', params: { type: 'object', properties: { code: { type: 'string' }, days: { type: 'number', description: '交易日数（5-120，默认30）' } }, required: ['code'] }, handler: stockKline },
    { name: 'stock_news', desc: '个股公告/行业公告检索（东方财富免费接口）。仅客观陈列，严禁输出投资建议', params: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }, handler: stockNews },
    { name: 'stock_boards', desc: '行业板块资讯：涨幅榜/资金面客观数据（东方财富免费接口）。仅客观陈列，严禁输出投资建议', params: { type: 'object', properties: { limit: { type: 'number' } }, required: [] }, handler: stockBoards },
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
  logger.info(`[StockMCP] 已注册 ${tools.length} 个工具`);
}

export function createStockFinMcpServer(): McpServer {
  const registry = new ToolRegistry();
  registerStockTools(registry);
  return buildMcpServerFromRegistry('stock-fin-mcp', '1.0.0', registry, ['stock_quote', 'stock_kline', 'stock_news', 'stock_boards']);
}