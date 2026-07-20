import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { StockSDK } from 'stock-sdk';

const sdk = new StockSDK();

// ── Tool 1: 港股实时行情 ──
async function quoteHandler(args: any) {
  const code = String(args.code || '').replace(/[^0-9]/g, '');
  if (!code || code.length > 5) return { content: [{ type: 'text' as const, text: '请输入有效的港股代码，如 00700、09988' }], isError: true };
  try {
    const quotes = await sdk.quotes.cnSimple([`hk${code}`]);
    if (!quotes.length) return { content: [{ type: 'text' as const, text: `未找到代码 ${code} 的行情数据` }], isError: true };
    const q = quotes[0];
    return { content: [{ type: 'text' as const, text: JSON.stringify({
      code: q.code || code,
      name: q.name,
      price: q.price,
      changePercent: q.changePercent,
      changeAmount: q.changeAmount,
      high: q.high,
      low: q.low,
      open: q.open,
      prevClose: q.prevClose,
      volume: q.volume,
      turnover: q.turnover,
      timestamp: new Date().toISOString(),
    }, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `查询失败: ${e.message}` }], isError: true };
  }
}

// ── Tool 2: 港股K线 ──
async function klineHandler(args: any) {
  const code = String(args.code || '').replace(/[^0-9]/g, '');
  if (!code) return { content: [{ type: 'text' as const, text: '请输入有效的港股代码' }], isError: true };
  try {
    const data = await sdk.kline.hk(code, { period: (args.period || 'daily') as any, limit: Math.min(args.limit || 30, 100) });
    const bars = (data?.data || data || []).slice(-20).map((b: any) => ({
      date: b.date || b.day,
      open: b.open, close: b.close, high: b.high, low: b.low, volume: b.volume,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ code, count: bars.length, bars }, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `K线查询失败: ${e.message}` }], isError: true };
  }
}

// ── Tool 3: 批量港股 ──
async function batchHandler(args: any) {
  const raw = String(args.codes || '');
  const codes = raw.split(/[,，\s]+/).map((c: string) => c.replace(/[^0-9]/g, '')).filter(Boolean).slice(0, 10);
  if (!codes.length) return { content: [{ type: 'text' as const, text: '请提供港股代码列表，如 00700,09988,00388' }], isError: true };
  try {
    const quotes = await sdk.quotes.cnSimple(codes.map((c: string) => `hk${c}`));
    const results = quotes.map((q: any) => ({
      code: q.code, name: q.name, price: q.price, changePercent: q.changePercent,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ count: results.length, results }, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `批量查询失败: ${e.message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'hk-stock', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('hk_quote', {
  description: '查询港股实时行情。输入港股代码（如 00700 腾讯, 09988 阿里, 00388 港交所），返回实时价格、涨跌幅、成交量等。',
  inputSchema: { code: z.string().describe('港股代码，如 00700（腾讯）、09988（阿里巴巴）、03690（美团）') },
}, quoteHandler);

server.registerTool('hk_kline', {
  description: '查询港股K线数据。支持日/周/月K线，返回最近N条。',
  inputSchema: {
    code: z.string().describe('港股代码'),
    period: z.string().optional().describe('K线周期: daily/weekly/monthly，默认 daily'),
    limit: z.number().optional().describe('返回条数，默认 30，最大 100'),
  },
}, klineHandler);

server.registerTool('hk_batch', {
  description: '批量查询多只港股实时行情。一次查询最多10只。',
  inputSchema: { codes: z.string().describe('港股代码列表，用逗号分隔，如 00700,09988,03690') },
}, batchHandler);

const transport = new StdioServerTransport();
await server.connect(transport);
