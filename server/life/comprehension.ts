// 数字生命体 — 理解状态模块（T80 任务4 + 第二阶段 任务1/2）
// 感知 PeppaOS 对当前对话/上下文的理解程度：事件清晰度 + 背景清晰度
export interface ComprehensionState {
  eventClarity: number;
  contextClarity: number;
  overall: number;
  lastUpdated: string;
  missingAspects: string[];
}

const DEFAULT_STATE: ComprehensionState = {
  eventClarity: 0.3,
  contextClarity: 0.2,
  overall: 0.25,
  lastUpdated: new Date().toISOString(),
  missingAspects: [],
};

let currentState: ComprehensionState = { ...DEFAULT_STATE };

export function getComprehensionState(): ComprehensionState {
  return { ...currentState };
}

// 第二阶段：感知判定升级 — 事件清晰度（是否有明确行为/对象）+ 背景清晰度（是否有上下文线索）
// + 泛化疑问识别（"我该怎么办""怎么做才好"这类短泛问 = 信息不足，需追问）
const ACTION_WORDS = /(工作|换|去|做|选|决定|想|要|能|会|查|找|买|写|学|修|打|开|关|删|发|安排|计划|准备|了解|分析|解决|处理|帮忙|建议|推荐|读|看|听|吃|玩|睡|走|到|给|帮|申请|注册|登录|退出)/;
const CONTEXT_WORDS = /(因为|原因|背景|之前|曾经|一直|最近|今天|昨天|明天|早上|晚上|关于|提到|说了|聊到|情况|事情)/;
const VAGUE_QUESTION = /^(那|这|我|你)?(应该|该|要不要|可不可以|能不能|怎么办|怎么做|如何|怎么)[好不好办做才好]?[?？]?$/;

export function updateComprehension(text: string): ComprehensionState {
  // 修复(问题2): 呼唤/确认语豁免 — "佩奇""可以""好的""嗯"这类短句不是信息不足，是社交回应，
  // 追问会让用户觉得模板化/死循环。豁免后按高理解度处理（走正常 LLM 流程）。
  const greetingTrimmed = text.trim();
  if (greetingTrimmed.length < 5 && /^(你好|哈喽|嗨|佩奇|可以|好的|好|嗯|哦|行|ok|okay|hi|hello|hey)$/i.test(greetingTrimmed)) {
    currentState = { ...currentState, overall: 0.8, missingAspects: [], lastUpdated: new Date().toISOString() };
    return { ...currentState };
  }

  const state = { ...currentState };
  const lower = text.toLowerCase();
  const trimmed = text.trim();

  const hasDetail = trimmed.length >= 8; // 有具体描述（长度线索）
  const hasAction = ACTION_WORDS.test(lower);
  const hasContext = CONTEXT_WORDS.test(lower);
  const isVague = VAGUE_QUESTION.test(trimmed);

  // 泛化疑问 = 明确的信息不足信号；有动作/有长度 → 事件已较清晰
  state.eventClarity = isVague ? 0.2 : (hasAction || hasDetail ? 0.75 : 0.35);
  state.contextClarity = hasContext ? 0.75 : (hasDetail ? 0.6 : 0.3);
  state.overall = (state.eventClarity + state.contextClarity) / 2;

  state.missingAspects = [];
  if (state.eventClarity < 0.5) state.missingAspects.push('具体事件');
  if (state.contextClarity < 0.5) state.missingAspects.push('背景信息');

  state.lastUpdated = new Date().toISOString();
  currentState = state;
  return state;
}

/** T80: 每 TICK 自然衰减 — 长时间不对话，理解度缓慢回落 */
export function tickComprehension(): void {
  currentState.overall = Math.max(0.1, currentState.overall - 0.01);
  currentState.lastUpdated = new Date().toISOString();
}
