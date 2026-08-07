import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// 公共 SearXNG 实例列表（免费、无需 Key）
const SEARXNG_INSTANCES = [
  'https://search.saptiva.com',
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://searx.tiekoetter.com',
];

async function handler(args: any) {
  const query = String(args.query || '').trim();
  if (!query) return { content: [{ type: 'text' as const, text: '请输入搜索关键词' }], isError: true };

  const limit = Math.min(Math.max(parseInt(args.limit) || 5, 1), 20);
  const language = args.language || 'zh-CN';

  for (const baseUrl of SEARXNG_INSTANCES) {
    try {
      const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&language=${language}&categories=general`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'MayOS/2.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;

      const data: any = await res.json();
      const results = (data.results || []).slice(0, limit).map((r: any) => ({
        title: r.title || '',
        snippet: (r.content || r.snippet || '').replace(/<[^>]*>/g, '').slice(0, 300),
        url: r.url || '',
        source: r.engine || '',
      }));

      if (results.length === 0) continue;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ query, total: data.number_of_results || results.length, results }, null, 2),
        }],
      };
    } catch {
      // 当前实例不可用，尝试下一个
      continue;
    }
  }

  return { content: [{ type: 'text' as const, text: `搜索 "${query}" 失败：所有搜索实例暂不可用，请稍后重试` }], isError: true };
}

const server = new McpServer({ name: 'cn-search', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('search_cn', {
  description: '搜索中文网页。用中文关键词搜索国内互联网内容，返回标题、摘要和链接。适合搜索中国新闻、股票、天气、政策等中文信息。',
  inputSchema: {
    query: z.string().describe('搜索关键词，如"今日世界杯比赛"、"茅台股价"、"北京天气"'),
    limit: z.number().optional().describe('返回结果数量，默认5条，最多20条'),
    language: z.string().optional().describe('搜索结果语言，默认 zh-CN（简体中文）'),
  },
}, handler);

const transport = new StdioServerTransport();
await server.connect(transport);
