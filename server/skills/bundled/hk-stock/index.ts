import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Tencent Finance API — confirmed working from NAS for HK + A-shares
async function fetchQuote(code: string, market: string): Promise<Record<string, string>> {
  const prefix = market === 'sh' ? 'sh' : market === 'sz' ? 'sz' : `hk`;
  const urlPath = `/q=${prefix}${code}`;
  return new Promise((resolve, reject) => {
    const https = require('https');
    https.get({ hostname: 'qt.gtimg.cn', path: urlPath, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res: any) => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => {
        const inner = data.split('"')[1] || '';
        const parts = inner.split('~');
        if (parts.length < 10) return reject(new Error('no data'));
        resolve({ name: parts[1], code: parts[2], price: parts[3], prevClose: parts[4],
          open: parts[5], volume: parts[6], high: parts[33], low: parts[34],
          changeAmount: parts[31], changePercent: parts[32], date: parts[30]?.slice(0, 10) || '' });
      });
    }).on('error', reject).setTimeout(8000, () => { reject(new Error('timeout')); });
  });
}

/** Detect market from stock code — returns {market, code} */
function detectMarket(raw: string): { market: string; code: string } {
  const c = raw.replace(/[^0-9]/g, '');
  if (c.length >= 5 && /^0/.test(c) && c.length <= 5) return { market: 'hk', code: c };
  if (c.length === 6 && /^6/.test(c)) return { market: 'sh', code: c };
  if (c.length === 6 && /^[03]/.test(c)) return { market: 'sz', code: c };
  if (c.length >= 5 && c.length <= 6) return { market: 'hk', code: c }; // fallback: treat 5-6 digit as HK
  return { market: 'hk', code: c };
}

const MARKET_LABELS: Record<string, string> = { hk: 'HKD', sh: 'CNY', sz: 'CNY' };

async function quoteHandler(args: any) {
  const raw = String(args.code || '').trim();
  if (!raw) return { content: [{ type: 'text' as const, text: '请输入股票代码或名称，如 00700(腾讯)、600519(茅台)、000001(平安)' }], isError: true };
  const { market, code } = detectMarket(raw);
  try {
    const q = await fetchQuote(code, market);
    return { content: [{ type: 'text' as const, text: JSON.stringify({
      market: market === 'hk' ? '港股' : market === 'sh' ? '沪A' : '深A',
      code: q.code, name: q.name, price: `${q.price} ${MARKET_LABELS[market]}`,
      changePercent: q.changePercent + '%', changeAmount: q.changeAmount,
      open: q.open, high: q.high, low: q.low, prevClose: q.prevClose,
      volume: q.volume, date: q.date, timestamp: new Date().toISOString(),
    }, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `查询 ${raw} 失败: ${e.message}` }] };
  }
}

async function batchHandler(args: any) {
  const raw = String(args.codes || '');
  const codes = raw.split(/[,，\s]+/).map((c: string) => c.trim()).filter(Boolean).slice(0, 10);
  if (!codes.length) return { content: [{ type: 'text' as const, text: '请提供股票代码列表' }] };
  const results = await Promise.all(codes.map(async (c: string) => {
    const { market, code } = detectMarket(c);
    try { const q = await fetchQuote(code, market); return { code: q.code, name: q.name, price: q.price, changePercent: q.changePercent + '%', market }; }
    catch { return { code: c, error: '查询失败' }; }
  }));
  return { content: [{ type: 'text' as const, text: JSON.stringify({ count: results.length, results }, null, 2) }] };
}

async function klineHandler(args: any) {
  const raw = String(args.code || '').trim();
  const { market, code } = detectMarket(raw);
  try {
    const q = await fetchQuote(code, market);
    return { content: [{ type: 'text' as const, text: JSON.stringify({
      code: q.code, name: q.name, market, price: q.price, changePercent: q.changePercent + '%',
      open: q.open, high: q.high, low: q.low, prevClose: q.prevClose,
      note: 'K线详细数据请使用 stock_quote 查看当前行情',
      timestamp: new Date().toISOString(),
    }, null, 2) }] };
  } catch (e: any) { return { content: [{ type: 'text' as const, text: `查询失败: ${e.message}` }] }; }
}

const server = new McpServer({ name: 'stock', version: '2.0.0' }, { capabilities: { tools: {} } });

server.registerTool('get_stock_quote', {
  description: '查询股票实时行情，自动识别港股/A股。港股代码如00700(腾讯)、03690(美团)、09988(阿里)；A股代码如600519(茅台)、000001(平安)。数据源:腾讯财经。',
  inputSchema: { code: z.string().describe('股票代码，港股如00700 03690，A股如600519 000001，或中文名称') },
}, quoteHandler);

server.registerTool('get_stock_batch', {
  description: '批量查询多只股票实时行情，自动识别港股/A股。',
  inputSchema: { codes: z.string().describe('股票代码，逗号分隔，如 00700,600519,03690') },
}, batchHandler);

server.registerTool('get_stock_kline', {
  description: '查询股票日内行情数据，自动识别港股/A股。',
  inputSchema: { code: z.string().describe('股票代码') },
}, klineHandler);

const transport = new StdioServerTransport();
await server.connect(transport);
