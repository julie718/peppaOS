import { ToolRegistry } from '../registry';
import { classifyBuiltinToolRisk } from '../../skills_extension/risk_policy';
import { saveSearchRecord } from '../../db/lifeDb';
import { logger } from '../../lib/logger';
import type { ToolContext } from '../types';

async function tryBingSearch(query: string, maxResults: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(
      `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&mkt=zh-CN`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      },
    );
    clearTimeout(timeout);
    if (!response.ok) return null;

    const html = await response.text();
    const results: string[] = [];

    // Bing 2024+ HTML: <li class="b_algo"> blocks
    const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    let blockMatch;
    while ((blockMatch = blockRe.exec(html)) !== null && results.length < maxResults) {
      const block = blockMatch[1];
      const urlMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>/i);
      const h2Match = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      const title = h2Match ? h2Match[1].replace(/<[^>]+>/g, '').trim() : (urlMatch ? urlMatch[1] : '');
      const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
        || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (urlMatch) {
        results.push(`${title}\n${snippet}\n${urlMatch[1]}`);
      }
    }

    // Fallback: broader extraction if b_algo blocks not found
    if (results.length === 0) {
      const broadRe = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>\s*<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
      let m;
      while ((m = broadRe.exec(html)) !== null && results.length < maxResults) {
        results.push(`${m[2].replace(/<[^>]+>/g, '').trim()}\n${m[1]}`);
      }
    }
    return results.length > 0 ? results.join('\n\n') : null;
  } catch {
    return null;
  }
}

/**
 * Phase2 模块5：从搜索结果文本中提取摘要/结论/来源URL（原始全文不落库，仅内存即弃）。
 * summary：前 500 字符的扁平化摘要；conclusions：各结果块首行标题；sourceUrls：去重 URL 列表。
 */
function parseSearchOutput(rawText: string, maxResults: number): {
  summary: string;
  conclusions: string[];
  sourceUrls: string[];
  resultCount: number;
} {
  const blocks = rawText.split(/\n\n+/).map(b => b.trim()).filter(Boolean);
  const conclusions: string[] = [];
  const sourceUrls: string[] = [];
  const urlRe = /https?:\/\/[^\s)"'<>，。；]+/g;

  for (const block of blocks) {
    const firstLine = block.split('\n')[0].trim();
    if (firstLine && !firstLine.startsWith('http')) conclusions.push(firstLine.slice(0, 120));
    for (const m of block.match(urlRe) || []) {
      if (!sourceUrls.includes(m)) sourceUrls.push(m);
    }
  }

  return {
    summary: rawText.replace(/\s+/g, ' ').trim().slice(0, 500),
    conclusions: conclusions.slice(0, Math.max(maxResults, 5)),
    sourceUrls: sourceUrls.slice(0, 10),
    resultCount: Math.min(Math.max(blocks.length, 1), maxResults),
  };
}

/** 摘要化持久化搜索记录；落库失败只记日志，绝不阻断搜索结果返回。 */
async function persistSearch(
  query: string,
  maxResults: number,
  provider: string,
  rawText: string,
  context?: ToolContext,
): Promise<void> {
  try {
    const parsed = parseSearchOutput(rawText, maxResults);
    await saveSearchRecord({
      userId: context?.userId,
      query,
      provider,
      summary: parsed.summary,
      conclusions: parsed.conclusions,
      sourceUrls: parsed.sourceUrls,
      resultCount: parsed.resultCount,
    });
    // 动作通道（logs/action.log）：与验收文档模块5一致，搜索记录落库标记走工具动作通道
    logger.action(`[web_search] 记录落库 provider=${provider} query="${query.slice(0, 50)}" results=${parsed.resultCount}`);
  } catch (err: any) {
    logger.error(`[web_search] 搜索记录落库失败（不影响搜索结果）: ${err?.message || err}`);
  }
}

async function webSearchHandler(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const query = String(args.query || '');
  if (!query.trim()) throw new Error('Search query is required.');

  const maxResults = Math.min(Math.max(Number(args.maxResults) || 5, 1), 10);

  // Bing first — works in China, returns real search results
  const bingResults = await tryBingSearch(query, maxResults);
  if (bingResults) {
    await persistSearch(query, maxResults, 'bing', bingResults, context);
    return bingResults;
  }

  // Fallback: DuckDuckGo Instant Answers (useful for definitions/facts)
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json() as any;
      const results: string[] = [];

      if (data.AbstractText) {
        results.push(`${data.AbstractText}${data.AbstractURL ? ` (${data.AbstractURL})` : ''}`);
      }

      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics.slice(0, maxResults)) {
          if (topic.Text && topic.FirstURL) {
            results.push(`${topic.Text}\n${topic.FirstURL}`);
          }
        }
      }

      if (data.Results && Array.isArray(data.Results)) {
        for (const r of data.Results.slice(0, maxResults)) {
          if (r.Text && r.FirstURL) {
            results.push(`${r.Text}\n${r.FirstURL}`);
          }
        }
      }

      if (results.length > 0) {
        const ddgText = results.join('\n\n');
        await persistSearch(query, maxResults, 'duckduckgo', ddgText, context);
        return ddgText;
      }
    }
  } catch {
    // DDG unavailable
  }

  return `No search results found for "${query}". Try different search terms or use url_fetch on a known news site.`;
}

async function urlFetchHandler(args: Record<string, any>): Promise<string> {
  const url = String(args.url || '');
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('URL must start with http:// or https://');
  }

  const maxChars = Math.min(Math.max(Number(args.maxChars) || 10000, 100), 50000);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MayOS/2.0 (Agent Tool)' },
    });
    clearTimeout(timeout);

    if (response.status === 401 || response.status === 403) {
      return `URL fetch requires authentication (${response.status}). Ask the user to authorize a web login profile, then use web_login_run and url_fetch_logged_in for this site.`;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('application/json') && !contentType.includes('application/xml')) {
      throw new Error(`Unsupported content type: ${contentType}. Only text, JSON, and XML are supported.`);
    }

    let text = await response.text();
    // Strip HTML tags
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();

    if (looksLikeLoginWall(text)) {
      return 'This page appears to require login or interactive verification. Ask the user to authorize a web login profile, then use web_login_run and url_fetch_logged_in.';
    }

    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} characters]`;
    }

    return text || '(No text content extracted)';
  } catch (err: any) {
    // 铁则3：不把原始错误字符串当作"成功结果"返回给 LLM 上下文（否则原始 message
    // 可能经 LLM 转述进入用户可见内容，且完整堆栈无从记入日志）。
    // 重新抛出，由 registry.execute 的 toFriendlyToolError 统一分类：
    // 完整堆栈 → 服务日志，对外只暴露友好文案（AbortError→timeout，fetch 失败→network）。
    throw err;
  }
}

function looksLikeLoginWall(text: string): boolean {
  const sample = text.slice(0, 4000).toLowerCase();
  const loginTerms = [
    'sign in', 'log in', 'login required', 'please login', 'please sign in',
    '验证码', '登录', '请登录', '账号密码', '扫码登录', '安全验证',
  ];
  return loginTerms.some(term => sample.includes(term.toLowerCase()))
    && !sample.includes('article')
    && text.length < 8000;
}

export function registerWebOpsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'web_search',
    description: 'Search the web via Bing (cn.bing.com). Returns formatted results with titles, snippets, and URLs. For Chinese news, use specific terms like "AI 人工智能 最新进展 2025". If results are poor, try url_fetch on known news sites like techcrunch.com, theverge.com, or 36kr.com.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { type: 'number', description: 'Maximum results (1-10, default 5)' },
      },
      required: ['query'],
    },
    handler: webSearchHandler,
    permission: 'user',
    securityLevel: classifyBuiltinToolRisk('Search the web via Bing (cn.bing.com). Returns formatted results with titles, snippets, and URLs. For Chinese news, use specific terms like "AI 人工智能 最新进展 2025". If results are poor, try url_fetch on known news sites like techcrunch.com, theverge.com, or 36kr.com.'),
  });

  registry.register({
    name: 'url_fetch',
    description: 'Fetch and extract text content from a URL. Strips HTML tags and returns plain text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (must start with http:// or https://)' },
        maxChars: { type: 'number', description: 'Maximum characters to return (default 10000, max 50000)' },
      },
      required: ['url'],
    },
    handler: urlFetchHandler,
    permission: 'user',
    securityLevel: classifyBuiltinToolRisk('Fetch and extract text content from a URL. Strips HTML tags and returns plain text.'),
  });
}
