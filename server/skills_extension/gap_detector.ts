// 阶段三·模块1 — 能力缺口识别与自主规划引擎
// 数据来源：长期对话记忆（queryMemories）+ 交互复盘记录（interaction_memories）+ 用户需求表达样本。
// 决策链路（顶层业务规则，优先级不可颠倒）：
//   路径A（优先执行）：检索到合规、稳定、低成本、协议兼容的成熟外部工具 → 外部工具适配改造流程
//   路径B（兜底仅）：无合格外部工具资源 → 启动沙箱 MCP 自研流程
// 完整推理链持久存入长期记忆，支持复盘"选择复用/自研工具"的全部判断依据。

import { queryMemories } from '../memory/store';
import { getLifeDb } from '../db/lifeDb';
import { logger } from '../lib/logger';
// Phase4: 旧模块 addMemory 直接写入迁移 — 事件封装后经 runInnerTick 统一落库（仅 innerTick.ts 内部允许 addMemory）
import { runInnerTick } from '../../src/core/innerTick';
import type { MentalEventItem } from '../../src/types/innerTickSchema';
// Phase4: 全局功能开关 — 缺口推理链记忆写入受旧空闲大脑逻辑开关控制
import { MIND_SWITCH } from '../../src/config/mindSwitch';
import { appendAudit } from './database';
import type { SkillGap } from './types';

// ── 数据采集 ──

/** 从 life.db interaction_memories 读取最近交互复盘记录（只读） */
async function readRecentInteractionMemories(limit = 200): Promise<Array<{ content: string; created_at?: string }>> {
  return new Promise((resolve) => {
    try {
      getLifeDb().all(
        'SELECT content, created_at FROM interaction_memories ORDER BY id DESC LIMIT ?',
        [limit],
        (err, rows) => { resolve(err ? [] : (rows as any[])); },
      );
    } catch { resolve([]); }
  });
}

/** 从长期记忆读取待处理/能力相关记忆 */
function readLongTermMemory(): string[] {
  try {
    return queryMemories({ userId: 'default', limit: 150, noTouch: true })
      .filter(m => m.tier === 'episodic' || m.tier === 'internalized')
      .map(m => m.content || '');
  } catch { return []; }
}

// ── 缺口关键词候选（数据驱动：由表达样本统计，非意图正则） ──

/**
 * 从语料中提取候选能力关键词：
 * 统计"需要查询/没有工具/能不能帮我查"类表达的宾语名词。
 * 纯统计启发（数据形态），无 LLM 时兜底；有 LLM 时由心智提取（见 extractGapsWithLLM）。
 */
function extractKeywordCandidates(corpus: string[]): Array<{ keyword: string; evidence: string[] }> {
  const counts = new Map<string, { keyword: string; evidence: string[] }>();
  // 需求表达框架（统计先验：需求信号的常见句式骨架，非固定答案）
  const demandSignals = /(查|查一下|看看|有没有.*工具|能不能|可以.*吗|怎么|如何|需要|想(要|看|知道)|关注)/;
  const domainHints = /(美股|港股|A股|股票|基金|汇率|油价|金价|加密货币|BTC|ETH|天气|新闻|资讯|体育|比赛|比分|电影|票房|综艺|动画|游戏|steam|翻译|论文|arxiv|百科|维基|菜谱|食谱|药物|药品|医院|航班|火车|酒店|外卖|股票行情|公司财报|裁员|招聘|工资|房价|房租|签证|移民|考研|考公)/;
  const stopwords = ['怎么', '如何', '什么', '一个', '这个', '那个', '我', '你', '吗', '的', '了', '呢', '帮'];

  for (const text of corpus) {
    if (!text || !demandSignals.test(text)) continue;
    const hits = text.match(domainHints);
    if (!hits) continue;
    for (const hit of hits) {
      const kw = hit.replace(/[的了吗呢帮我]?$/g, '');
      if (!kw || stopwords.includes(kw)) continue;
      const entry = counts.get(kw) || { keyword: kw, evidence: [] };
      entry.evidence.push(text.slice(0, 120));
      counts.set(kw, entry);
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.evidence.length - a.evidence.length)
    .slice(0, 10);
}

// ── 决策链（路径A优先，硬编码锁定优先级） ──

/**
 * 路径判定：优先复用（路径A）；仅当搜索无合格结果时才转路径B（自研）。
 * 本函数由 search_engine 在完成七维评估后回调；此处保证"优先级不可颠倒"。
 */
export function decidePathFromCandidates(
  eligibleCount: number,
  disqualifiedCount: number,
  gap: string,
): { path: 'reuse' | 'self_build'; reasons: string[] } {
  if (eligibleCount > 0) {
    return {
      path: 'reuse',
      reasons: [`检索到 ${eligibleCount} 个七维达标的外部工具（淘汰 ${disqualifiedCount} 个不达标候选），按顶层规则优先复用`],
    };
  }
  return {
    path: 'self_build',
    reasons: [
      `全网检索无七维达标的成熟工具（达标 0，淘汰 ${disqualifiedCount}），满足自研兜底触发条件①"无匹配需求的成熟工具"`,
      `自研仅作兜底：优先级规则（复用 > 自研）未颠倒`,
    ],
  };
}

// ── 主流程 ──

export interface GapDetectResult {
  gaps: SkillGap[];
  sources: { memory: number; interactions: number };
}

/** 全量缺口扫描：记忆 + 交互复盘 → 统计高频未满足需求 */
export async function detectGaps(): Promise<GapDetectResult> {
  const longTerm = readLongTermMemory();
  const interactions = await readRecentInteractionMemories();
  const corpus = [...longTerm, ...interactions.map(i => i.content)];

  const candidates = extractKeywordCandidates(corpus);
  const now = new Date().toISOString();

  const gaps: SkillGap[] = candidates.map((c, i) => ({
    id: `gap_${Date.now()}_${i}`,
    keyword: c.keyword,
    evidence: c.evidence.slice(0, 3),
    frequency: c.evidence.length,
    lastSeenAt: now,
    status: 'pending',
    createdAt: now,
  }));

  if (gaps.length > 0) {
    for (const g of gaps) {
      await appendAudit('gap_detected', g.keyword, `频次=${g.frequency}，样本=${g.evidence.length}条`);
    }
  } else {
    await appendAudit('gap_detected', 'none', `本轮无新缺口（记忆 ${longTerm.length} 条，交互 ${interactions.length} 条）`);
  }

  return { gaps, sources: { memory: longTerm.length, interactions: interactions.length } };
}

/** 推理链写入长期记忆（可复盘） */
export async function persistGapReasoning(gap: SkillGap, chain: Record<string, unknown>): Promise<void> {
  // Phase4: 原 addMemory 直接写入迁移 — 事件封装后经 runInnerTick 统一落库（仅 innerTick.ts 内部允许 addMemory），
  // 受 enableOldIdleBrain 开关控制，开关关闭时整套旧记忆写入逻辑不执行
  if (!MIND_SWITCH.enableOldIdleBrain) return;
  try {
    const evt: MentalEventItem = {
      source: 'skills_extension',
      eventType: 'gap_reasoning',
      brief: `能力缺口推理链：${gap.keyword}`,
      payload: {
        content: `能力缺口复盘：用户高频需求"${gap.keyword}"（${gap.frequency} 次）→ ${chain.decisionPath === 'reuse' ? '路径A·复用外部工具' : '路径B·沙箱自研'}。判断依据：${JSON.stringify(chain)}`,
        keywords: ['能力缺口', gap.keyword, '技能拓展'],
        type: 'fact',
        tier: 'growth',
        perspective: 'owner_trait',
        importance: 0.5,
      },
    };
    void runInnerTick({ userId: 'default', derivedMentalEvents: [evt] }).catch((e: any) =>
      logger.warn(`[SkillsGap] 推理链心智事件派发失败: ${e?.message || e}`),
    );
    logger.info(`[SkillsGap] 推理链已封装为心智事件: ${gap.keyword} → ${chain.decisionPath}`);
  } catch (e: any) {
    logger.warn(`[SkillsGap] 推理链写入记忆失败: ${e.message}`);
  }
}

/** 能力缺口入口：检测 + 规划（返回缺口及决策建议，供编排层驱动检索/沙箱） */
export async function planSkillExtension(): Promise<Array<{ gap: SkillGap; recommendation: 'reuse' | 'self_build' }>> {
  const { gaps } = await detectGaps();
  // 规划层：进入检索评估（模块2）前的默认建议 —— 顶层规则：一律先走路径A检索评估，由七维评分裁决
  return gaps.map(gap => ({ gap, recommendation: 'reuse' as const }));
}
