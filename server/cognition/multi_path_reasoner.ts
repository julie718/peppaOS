// 阶段一·模块3: 并行多路径因果推理引擎
// 思路：同一问题走 N 条独立推演链路（不同视角/立场 prompt），并行执行后交叉校验。
// 多链路结论一致 → 高置信输出；结论分歧 → 并列呈现分歧点，不武断下结论（降幻觉）。
// LLM 调用可注入（E2E 用 mock 校验纯逻辑），无 LLM 时退化为纯结构校验。
import { logger } from '../lib/logger';

// ── 推演视角（每条链路一个独立视角，避免同质化）──
export const REASON_PERSPECTIVES = [
  { name: '理性实证', prompt: '请从事实、证据与逻辑严密性角度推演，只陈述有依据的因果链条，明确标注不确定处。' },
  { name: '反面证伪', prompt: '请专门寻找该结论的反例、脆弱环节与隐藏假设，指出何种情况下结论不成立。' },
  { name: '多因合流', prompt: '请从系统视角列出所有可能影响结果的因变量与权重，不要只盯单一原因。' },
] as const;

export interface PathResult {
  perspective: string;
  conclusion: string;
  confidence: number;      // 0-1 该链路自评
  reasoning: string;       // 推演摘要
  caveats: string[];       // 该链路发现的疑点
}

export interface CrossValidateOutput {
  paths: PathResult[];
  agreed: boolean;                       // 是否达成一致
  agreement: number;                     // 一致度 0-1
  consensus: string | null;              // 一致结论（agreed 时为交叉结论）
  conflictingPoints: string[];           // 分歧点
  finalConfidence: number;               // 综合置信度
  verdict: 'consensus' | 'conflict' | 'insufficient';
}

/**
 * 纯函数：多路径结论交叉校验（可单测）
 * 一致度 = 结论关键词重合率；阈值默认 0.5（过半一致视为共识）。
 * 分歧时收集各路径的冲突点与疑点，标记待核实——不替用户下结论。
 */
export function crossValidatePaths(paths: PathResult[], threshold = 0.5): CrossValidateOutput {
  const total = paths.length;
  if (total === 0) {
    return { paths, agreed: false, agreement: 0, consensus: null, conflictingPoints: ['无推演路径'], finalConfidence: 0, verdict: 'insufficient' };
  }
  const norm = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const keyOf = (p: PathResult) => norm(p.conclusion).slice(0, 24);
  const groupMap = new Map<string, PathResult[]>();
  for (const p of paths) {
    const k = keyOf(p);
    groupMap.set(k, (groupMap.get(k) || []).concat(p));
  }
  const groups = [...groupMap.values()].sort((a, b) => b.length - a.length);
  const agreement = groups[0].length / total;
  // 严格大于阈值：2 条链路各执一词时 agreement=0.5 不得算共识（必须过半一致）
  const agreed = agreement > threshold && groups[0][0].conclusion.length > 0;

  const caveats = paths.flatMap(p => p.caveats || []);
  const conflictingPoints = [...new Set(caveats)];

  let finalConfidence = 0;
  if (agreed) {
    const avg = groups[0].reduce((s, p) => s + p.confidence, 0) / groups[0].length;
    finalConfidence = Math.min(0.95, avg * (0.6 + agreement * 0.4));
  } else if (total >= 2) {
    finalConfidence = 0.3; // 分歧时置信度压低，提醒外部核实
  }

  return {
    paths,
    agreed,
    agreement,
    consensus: agreed ? groups[0][0].conclusion : null,
    conflictingPoints,
    finalConfidence,
    verdict: total < 2 ? 'insufficient' : agreed ? 'consensus' : 'conflict',
  };
}

export interface MultiPathOptions {
  llm?: (perspective: string, prompt: string, question: string) => Promise<{ conclusion: string; confidence: number; reasoning: string; caveats: string[] } | null>;
  perspectives?: typeof REASON_PERSPECTIVES;
  timeoutMs?: number;
}

/** 并行多路径推演：N 条链路并行执行（LLM 可注入），全部完成或超时后交叉校验 */
export async function multiPathReason(question: string, opts: MultiPathOptions = {}): Promise<CrossValidateOutput> {
  const perspectives = opts.perspectives || [...REASON_PERSPECTIVES];
  const llm = opts.llm || (async () => null);
  const timeoutMs = opts.timeoutMs || 45000;

  const withTimeout = async (p: Promise<PathResult | null>) => {
    const timer = new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs));
    return Promise.race([p, timer]);
  };

  const paths = await Promise.all(
    perspectives.map(async persp => {
      try {
        const r = await withTimeout(llm(persp.name, persp.prompt, question));
        if (!r) return null;
        return {
          perspective: persp.name,
          conclusion: r.conclusion,
          confidence: Math.max(0, Math.min(1, r.confidence || 0.5)),
          reasoning: r.reasoning || '',
          caveats: r.caveats || [],
        } as PathResult;
      } catch {
        return null;
      }
    }),
  );

  const valid = paths.filter((p): p is PathResult => p !== null);
  if (valid.length === 0) {
    return { paths: [], agreed: false, agreement: 0, consensus: null, conflictingPoints: ['所有推演链路均失败'], finalConfidence: 0, verdict: 'insufficient' };
  }
  const output = crossValidatePaths(valid);
  logger.info(`[MultiPathReason] "${question.slice(0, 30)}" ${valid.length} 路径 → ${output.verdict} 一致度 ${output.agreement.toFixed(2)} 置信 ${output.finalConfidence.toFixed(2)}`);
  return output;
}

/**
 * LLM 主链路失败时的多路径推理兜底（chat.ts 接线）：
 * 命中推理类问题（为什么/如果/会怎样/原因/影响等）→ 用运行时 LLM 并行跑 3 条推演链路；
 * 无可用模型或链路失败 → 返回 null，调用方回退原 handleLLMFailure。
 */
export async function tryMultiPathFallback(question: string): Promise<string | null> {
  const g = ((global as any).__llmGetters || {}) as Record<string, (() => any) | undefined>;
  const getter = (name: string): (() => any) => g[name] || (() => null);
  if (!/为什么|如果|会怎样|会怎么|原因|影响|预测|推测|导致|假设|可能(不)?会/.test(question)) return null;

  const llm = async (perspective: string, prompt: string, q: string) => {
    const model = getter('getDeepSeek')();
    if (!model) return null;
    const text = await Promise.race([
      (async () => {
        try {
          const r = await model.call(q, { systemPrompt: `${prompt}\n请以「${perspective}」视角回答，结论一句话（20字内），另附推演摘要（30字内）与疑点（最多2条）。` });
          const s = String(r?.text || r || '');
          if (!s.trim()) return null;
          const caveats = (s.match(/疑点[:：]\s*([^\n]+)/) || [])[1]?.split(/[；;]/).slice(0, 2) || [];
          return {
            conclusion: s.split('\n')[0].replace(/^(结论|推演)[:：]?\s*/, '').slice(0, 60),
            confidence: 0.6,
            reasoning: s.slice(0, 120),
            caveats,
          };
        } catch { return null; }
      })(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 20000)),
    ]);
    return text;
  };

  const output = await multiPathReason(question, { llm, timeoutMs: 20000 });
  if (output.verdict === 'insufficient') return null;
  return `🧠 多路径交叉推理兜底（主模型不可用）:\n` + formatReasonReport(output);
}

/** 人类可读的推理报告（供工具输出 / 对话注入） */
export function formatReasonReport(q: CrossValidateOutput): string {
  if (q.verdict === 'insufficient') return '⚠️ 推演链路不足，无法形成交叉校验结论，建议补充信息后重试。';
  const lines: string[] = [];
  if (q.verdict === 'consensus') {
    lines.push(`✅ 多路径交叉校验达成共识（${(q.agreement * 100).toFixed(0)}% 一致，置信度 ${(q.finalConfidence * 100).toFixed(0)}%）:`);
    lines.push(q.consensus || '');
  } else {
    lines.push(`⚠️ 多路径推演存在分歧（一致度 ${(q.agreement * 100).toFixed(0)}%），并列呈现各方观点:`);
    for (const p of q.paths) {
      lines.push(`【${p.perspective}】${p.conclusion}${p.caveats.length ? `（疑点: ${p.caveats.join('; ')}）` : ''}`);
    }
  }
  if (q.conflictingPoints.length) {
    lines.push('🔍 待核实要点: ' + [...new Set(q.conflictingPoints)].join('；'));
  }
  lines.push('⚖️ 交叉校验原则：分歧不武断下结论，请以可靠事实源为准。');
  return lines.join('\n');
}
