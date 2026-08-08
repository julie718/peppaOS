// 统一消息路由引擎 — 【重构】去固化前置分流
// 原实现：正则池前置分流（本能层 INSTINCT/IDENTITY / 工具层 STOCK/LOOKUP/WEATHER / NLU 意图 switch / 复杂度正则路由）。
// 重构后：原始输入直送心智内核（cognitive 层），意图/工具/复杂度全部由 LLM 心智自主推演；
// 本层仅保留：空消息拒收 + 基于情绪/人格状态数据的自我评估置信度（canSelfRespond，纯数据驱动）。
import { logger } from '../lib/logger';
import { getSelfState } from './selfState';

// ── 路由层级 ──
export type RouteLayer = 'cognitive' | 'unknown';

export interface RouteResult {
  layer: RouteLayer;
  reason: string;
  trace: string[];           // 完整决策路径
  canSelfRespond?: boolean;  // 自我评估：基于情绪和人格的置信度
}

// ── 主导出：统一路由入口 ──
export async function routeMessage(
  text: string,
  _operationMode: string = 'autonomous',
): Promise<RouteResult> {
  const trace: string[] = [];
  const trimmed = text.trim();

  // ── 自我评估：读取情绪和人格状态，计算置信度（数据驱动，非规则模板） ──
  let canSelfRespond = false;
  try {
    const state = await getSelfState();
    if (state?.emotion && state?.personality) {
      const vec = JSON.parse(state.personality.vector_json);
      // P2-2: emotion_state 行无 intensity 字段（原取值为 NaN → 开关永久失效），
      // 改用现有有效字段：情绪向量最大值作为当前情绪强度
      let emotionStrength = 0.5;
      try {
        const emotionVec = state.emotion?.vector_json ? JSON.parse(state.emotion.vector_json) : null;
        if (Array.isArray(emotionVec) && emotionVec.length > 0) emotionStrength = Math.max(...emotionVec);
      } catch {}
      const confidence = emotionStrength * 0.4 + (vec[2] || 0.5) * 0.6;
      canSelfRespond = confidence >= 0.6;
    }
  } catch {}

  // 空消息
  if (!trimmed) {
    return { layer: 'unknown', reason: 'empty_text', trace: ['rejected: empty'], canSelfRespond };
  }

  // 【重构】无正则前置匹配：原始输入直送心智内核（cognitive），
  // 意图识别（怀旧/规划/事实）、工具调度（是否/调用哪些工具）、复杂度判断全部由 LLM 心智完成。
  trace.push('mind: raw input → cognitive');
  return { layer: 'cognitive', reason: 'mind_driven', trace, canSelfRespond };
}
