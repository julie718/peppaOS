import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Use Tencent Finance API directly (verified working from NAS)
async function fetchTencent(code: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get({
      hostname: 'qt.gtimg.cn',
      path: `/q=hk${code}`,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        const inner = data.split('"')[1] || '';
        const parts = inner.split('~');
        if (parts.length < 10) return reject(new Error('invalid response'));
        resolve({
          name: parts[1], code: parts[2], price: parts[3], prevClose: parts[4],
          open: parts[5], volume: parts[6], high: parts[33], low: parts[34],
          changeAmount: parts[31], changePercent: parts[32],
          date: parts[30]?.slice(0, 10) || '',
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function quoteHandler(args: any) {
  const code = String(args.code || '').replace(/[^0-9]/g, '');
  if (!code) return { content: [{ type: 'text' as const, text: '请输入港股代码，如 00700' }], isError: true };
  try {
    const q = await fetchTencent(code);
    return { content: [{ type: 'text' as const, text: JSON.stringify({
      code: q.code, name: q.name, price: `${q.price} HKD`,
      changePercent: q.changePercent + '%', changeAmount: q.changeAmount,
      open: q.open, high: q.high, low: q.low, prevClose: q.prevClose,
      volume: q.volume, date: q.date,
      timestamp: new Date().toISOString(),
    }, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `查询失败: ${e.message}` }] };
  }
}

async function batchHandler(args: any) {
  const raw = String(args.codes || '');
  const codes = raw.split(/[,，\s]+/).map((c: string) => c.replace(/[^0-9]/g, '')).filter(Boolean).slice(0, 10);
  if (!codes.length) return { content: [{ type: 'text' as const, text: '请提供港股代码' }] };
  try {
    const results = await Promise.all(codes.map(async (c: string) => {
      try { return await fetchTencent(c); } catch { return { code: c, error: '查询失败' }; }
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ count: results.length, results }, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `批量查询失败: ${e.message}` }] };
  }
}

async function klineHandler(args: any) {
  const code = String(args.code || '').replace(/[^0-9]/g, '');
  try {
    const q = await fetchTencent(code);
    return { content: [{ type: 'text' as const, text: JSON.stringify({
      code: q.code, name: q.name,
      price: q.price, changePercent: q.changePercent + '%',
      open: q.open, high: q.high, low: q.low, prevClose: q.prevClose,
      volume: q.volume, date: q.date,
      note: 'K线详细数据请使用 hk_quote 查看当前行情',
    }, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `查询失败: ${e.message}` }] };
  }
}

const server = new McpServer({ name: 'hk-stock', version: '1.0.0' }, { capabilities: { tools: {} } });
server.registerTool('hk_quote', {
  description: '查询港股实时行情。输入港股代码（如 00700 腾讯, 09988 阿里），返回实时价格、涨跌幅。数据源:腾讯财经。',
  inputSchema: { code: z.string().describe('港股代码，如 00700 09988 03690') },
}, quoteHandler);
server.registerTool('hk_batch', {
  description: '批量查询多只港股实时行情，最多10只。',
  inputSchema: { codes: z.string().describe('港股代码，逗号分隔，如 00700,09988,03690') },
}, batchHandler);
server.registerTool('hk_kline', {
  description: '查询港股日内行情数据。',
  inputSchema: { code: z.string().describe('港股代码') },
}, klineHandler);

const transport = new StdioServerTransport();
await server.connect(transport);
