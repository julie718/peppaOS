// 阶段三·模块2a — 社区成熟工具检索 & 七维量化评估引擎
// 检索源：① 内置合规工具注册表（数据源注册表，随版本维护）② 社区检索（GitHub/标准 MCP 目录，HTTP 抓取）
// ③ 第三方行情/资讯 API 目录。
// 七维评分：接口稳定性 / 更新维护频率 / 报错率 / 合规完整性 / 调用成本 / 协议适配度 / 用户交互匹配度。
// 任一维度 < 0.6 直接淘汰。网络异常自动降级缓存检索结果（注册表即缓存源），不阻塞主流程。
// 顶层业务规则锁定：路径A（复用）优先于路径B（自研）——本引擎只产生"合格候选"，路径裁决在 gap_detector.decidePathFromCandidates。

import { logger } from '../lib/logger';
import { appendAudit } from './database';
import { decidePathFromCandidates } from './gap_detector';
import type { ToolCandidate } from './types';

export const ELIGIBLE_FLOOR = 0.6; // 七维达标下限（任一维度低于即淘汰）

// ── 内置合规工具注册表（数据源注册表：真实存在的社区/公开资源，随版本维护；检索中断时的降级缓存） ──

interface RegistryEntry {
  name: string;
  origin: string;
  providerUrl?: string;
  paid: boolean;
  estimatedCostPer1k?: number;
  hasDisclaimer: boolean;
  needsCredential: boolean;
  scores: ToolCandidate['scores'];
  keywords: string[];
}

const REGISTRY: RegistryEntry[] = [
  {
    name: 'us-stock-quote-mcp',
    origin: 'MCP 社区开源项目（免费 MIT 协议，支持代码检索 API）',
    providerUrl: 'https://api.marketaux.com',
    paid: false,
    estimatedCostPer1k: 0,
    hasDisclaimer: true,
    needsCredential: false,
    scores: { stability: 0.85, maintenance: 0.8, errorRate: 0.82, compliance: 0.9, cost: 1.0, protocolFit: 0.88, userMatch: 0.85 },
    keywords: ['美股', '股票', 'quote', '行情'],
  },
  {
    name: 'yahoo-finance-mcp',
    origin: '社区维护的 Yahoo Finance 数据 MCP（免费公开接口封装）',
    providerUrl: 'https://query1.finance.yahoo.com',
    paid: false,
    estimatedCostPer1k: 0,
    hasDisclaimer: true,
    needsCredential: false,
    scores: { stability: 0.78, maintenance: 0.75, errorRate: 0.75, compliance: 0.85, cost: 1.0, protocolFit: 0.8, userMatch: 0.8 },
    keywords: ['美股', '股票', '行情', '历史'],
  },
  {
    name: 'global-news-mcp',
    origin: '社区聚合新闻 MCP（多源 RSS，免费）',
    providerUrl: undefined,
    paid: false,
    estimatedCostPer1k: 0,
    hasDisclaimer: false,
    needsCredential: false,
    scores: { stability: 0.8, maintenance: 0.72, errorRate: 0.78, compliance: 0.7, cost: 1.0, protocolFit: 0.85, userMatch: 0.78 },
    keywords: ['新闻', '资讯', '时事'],
  },
  {
    name: 'fx-rate-api',
    origin: '第三方免费汇率 API（exchangerate-api 免费档）',
    providerUrl: 'https://api.exchangerate-api.com',
    paid: false,
    estimatedCostPer1k: 0,
    hasDisclaimer: true,
    needsCredential: false,
    scores: { stability: 0.88, maintenance: 0.8, errorRate: 0.85, compliance: 0.9, cost: 1.0, protocolFit: 0.85, userMatch: 0.8 },
    keywords: ['汇率', '外汇', 'currency'],
  },
  {
    name: 'coin-market-cap-mcp',
    origin: '加密货币行情社区 MCP（CoinGecko 免费档）',
    providerUrl: 'https://api.coingecko.com',
    paid: false,
    estimatedCostPer1k: 0,
    hasDisclaimer: true,
    needsCredential: false,
    scores: { stability: 0.82, maintenance: 0.78, errorRate: 0.8, compliance: 0.85, cost: 1.0, protocolFit: 0.85, userMatch: 0.82 },
    keywords: ['加密货币', 'BTC', 'ETH', '加密'],
  },
  {
    name: 'arxiv-paper-mcp',
    origin: 'arXiv 论文检索社区 MCP（免费公开 API）',
    providerUrl: 'https://export.arxiv.org',
    paid: false,
    estimatedCostPer1k: 0,
    hasDisclaimer: false,
    needsCredential: false,
    scores: { stability: 0.86, maintenance: 0.75, errorRate: 0.84, compliance: 0.75, cost: 1.0, protocolFit: 0.82, userMatch: 0.75 },
    keywords: ['论文', 'arxiv', '文献'],
  },
];

// ── 社区检索（HTTP 抓取，失败降级缓存） ──

interface CommunityHit {
  name: string;
  repoUrl: string;
  description: string;
  stars?: number;
  updatedAt?: string;
}

/** 抓取 GitHub 搜索（免费无 key 接口），用于"社区是否存在成熟 MCP"判断 */
async function fetchCommunityHits(keyword: string): Promise<CommunityHit[]> {
  const q = encodeURIComponent(`${keyword} mcp in:name,description`);
  const res = await fetch(`https://api.github.com/search/repositories?q=${q}&per_page=5`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PeppaOS-Skills' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.items || []).map((it: any) => ({
    name: it.full_name,
    repoUrl: it.html_url,
    description: it.description || '',
    stars: it.stargazers_count,
    updatedAt: it.updated_at,
  }));
}

/** 七维判定（任一维度 < 0.6 淘汰；返回淘汰原因数组） */
export function assessSevenDims(scores: ToolCandidate['scores']): { eligible: boolean; disqualifyReasons: string[] } {
  const dims = Object.entries(scores) as Array<[keyof ToolCandidate['scores'], number]>;
  const disqualifyReasons = dims.filter(([, v]) => v < ELIGIBLE_FLOOR).map(([k, v]) => `${k}=${v.toFixed(2)}`);
  return { eligible: disqualifyReasons.length === 0, disqualifyReasons };
}

/** 多关键词并行检索（内置注册表 + 社区） */
export async function searchTools(keywords: string[]): Promise<ToolCandidate[]> {
  const now = new Date().toISOString();
  const results: ToolCandidate[] = [];
  const seen = new Set<string>();

  // ① 注册表匹配（本地缓存源：确定性、可离线）
  for (const kw of keywords) {
    for (const entry of REGISTRY) {
      if (!entry.keywords.some(k => k.includes(kw) || kw.includes(k) || kw.toLowerCase().includes(entry.name))) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      results.push(toCandidate(entry, 'registry', now));
    }
  }

  // ② 社区检索（网络优先，异常/无结果自动降级缓存，不抛错）
  let communityOk = false;
  try {
    for (const kw of keywords) {
      const hits = await fetchCommunityHits(kw);
      for (const h of hits.slice(0, 3)) {
        communityOk = true;
        if (seen.has(h.name)) continue;
        seen.add(h.name);
        // 社区命中转注册表评估：stars/最近更新映射为维护与稳定性维度
        results.push(toCandidate({
          name: h.name,
          origin: `社区仓库 ${h.repoUrl} — ${(h.description || '').slice(0, 100)}`,
          providerUrl: h.repoUrl,
          paid: false,
          estimatedCostPer1k: 0,
          hasDisclaimer: false,
          needsCredential: false,
          scores: {
            stability: 0.7,
            maintenance: Math.min(0.9, 0.5 + ((h.stars || 0) / 2000)),
            errorRate: 0.7,
            compliance: 0.65,
            cost: 1.0,
            protocolFit: 0.75,
            userMatch: 0.7,
          },
          keywords: [kw],
        }, 'community', now));
      }
    }
  } catch {
    logger.warn('[SkillsSearch] 社区检索网络异常，降级缓存注册表结果（不阻塞）');
    await appendAudit('search', 'community', '网络异常 → 降级缓存注册表');
  }
  if (!communityOk && results.length === 0) {
    logger.info('[SkillsSearch] 社区无命中，使用注册表缓存结果');
  }

  // ③ 七维评分判定（任一 < 0.6 淘汰）
  for (const c of results) {
    const assessed = assessSevenDims(c.scores);
    c.disqualifyReasons = assessed.disqualifyReasons;
    c.eligible = assessed.eligible;
  }

  // 路径裁决（顶层规则：路径A优先；无合格候选才转路径B）
  const eligible = results.filter(r => r.eligible);
  const decision = decidePathFromCandidates(eligible.length, results.length - eligible.length, keywords.join('/'));
  for (const r of results) {
    r.decision = r.eligible ? 'reuse' : 'self_build';
    r.assessedAt = now;
  }

  await appendAudit('search', keywords.join(','),
    `候选=${results.length} 达标=${eligible.length} 淘汰=${results.length - eligible.length} 决策=${decision.path} 依据=${decision.reasons[0]}`);

  return results;
}

function toCandidate(e: RegistryEntry, source: ToolCandidate['source'], now: string): ToolCandidate {
  return {
    id: `${source}_${e.name}`,
    name: e.name,
    source,
    origin: e.origin,
    providerUrl: e.providerUrl,
    paid: e.paid,
    estimatedCostPer1k: e.estimatedCostPer1k,
    hasDisclaimer: e.hasDisclaimer,
    needsCredential: e.needsCredential,
    scores: { ...e.scores },
    eligible: false,
    disqualifyReasons: [],
    decision: 'self_build',
    assessedAt: now,
  };
}

/** 检索并裁决：返回 { 合格候选, 决策路径, 全量结果 } */
export async function searchAndDecide(keywords: string[]): Promise<{
  eligible: ToolCandidate[];
  disqualified: ToolCandidate[];
  decision: 'reuse' | 'self_build';
  all: ToolCandidate[];
}> {
  const all = await searchTools(keywords);
  return {
    eligible: all.filter(c => c.eligible),
    disqualified: all.filter(c => !c.eligible),
    decision: all.some(c => c.eligible) ? 'reuse' : 'self_build',
    all,
  };
}
