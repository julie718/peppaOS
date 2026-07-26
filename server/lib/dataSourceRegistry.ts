// 金融数据源注册 — hk-stock + stockbot
import { getDataSourceManager, DataSourceManager } from './dataSourceManager.js';
import { logger } from './logger.js';

const HTTP_TIMEOUT = 8000;

async function fetchWithTimeout(url: string, timeoutMs = HTTP_TIMEOUT): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const text = await resp.text();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 腾讯财经 — hk-stock 数据源 */
async function tencentQuery(code: string, type: string): Promise<any> {
  // 自动识别市场
  const c = code.replace(/[^0-9]/g, '');
  let prefix = 'hk';
  if (c.length === 6 && c.startsWith('6')) prefix = 'sh';
  else if (c.length === 6 && c.match(/^[03]/)) prefix = 'sz';
  else if (c.length >= 5 && c.startsWith('0')) prefix = 'hk';

  const text = await fetchWithTimeout(`https://qt.gtimg.cn/q=${prefix}${c}`);
  const inner = text.split('"')[1] || '';
  const parts = inner.split('~');
  if (parts.length < 10) throw new Error('腾讯财经无数据');

  return {
    name: parts[1], code: parts[2], price: parseFloat(parts[3]),
    prevClose: parseFloat(parts[4]), open: parseFloat(parts[5]),
    high: parseFloat(parts[33]), low: parseFloat(parts[34]),
    changePercent: parseFloat(parts[32]), market: prefix,
    source: '腾讯财经',
  };
}

/** 注册所有金融数据源 */
export function registerDataSources(): void {
  const mgr = getDataSourceManager();

  // stockbot — 优先级较高
  mgr.register({
    name: 'stockbot',
    priority: 10,
    healthCheck: async () => {
      try {
        await tencentQuery('00700', 'quote');
        return true;
      } catch { return false; }
    },
    query: async (code, type) => {
      return await tencentQuery(code, type);
    },
  });

  // hk-stock — 备选
  mgr.register({
    name: 'hk-stock',
    priority: 5,
    healthCheck: async () => {
      try {
        await tencentQuery('00700', 'quote');
        return true;
      } catch { return false; }
    },
    query: async (code, type) => {
      return await tencentQuery(code, type);
    },
  });

  mgr.startHealthChecks();
  logger.info('[DataSourceRegistry] 金融数据源已注册: stockbot(P10) + hk-stock(P5)');
}
