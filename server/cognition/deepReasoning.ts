// 深度推理引擎 — 四层架构
// 第1层: 信息检索 → 第2层: 规则推演 → 第3层: 验证闭环 → 第4层: 置信度输出
//
// 约束: 每次推理 LLM 调用 ≤ 3 次, 30s 超时自动降级
// 输出: 带不确定性的自然语言表达

import { logger } from '../lib/logger.js';

// ── 自身状态读取 ──
function getSelfState(): Promise<{ emotion: any | null; personality: any | null }> {
  return new Promise((resolve) => {
    try {
      const sqlite3 = require('sqlite3');
      const db = new sqlite3.Database('/app/data/life.db');
      db.get('SELECT * FROM emotions ORDER BY id DESC LIMIT 1', (err: any, emotionRow: any) => {
        if (err) {
          db.close();
          resolve({ emotion: null, personality: null });
          return;
        }
        db.get('SELECT * FROM personality ORDER BY id DESC LIMIT 1', (err2: any, personalityRow: any) => {
          db.close();
          if (err2) {
            resolve({ emotion: emotionRow, personality: null });
            return;
          }
          resolve({ emotion: emotionRow, personality: personalityRow });
        });
      });
    } catch (e) {
      resolve({ emotion: null, personality: null });
    }
  });
}

// ── 类型定义 ──

export interface DeepReasoningInput {
  text: string;
  userId?: string;
  personalityName?: string;
  context?: string;
}

export interface RetrievalResult {
  sources: { type: 'memory' | 'tool' | 'general'; content: string; relevance: number }[];
  summary: string;
  dataGaps: string[];
}

export interface DeductionResult {
  domain: string;
  reasoningChain: string[];
  intermediateConclusions: string[];
  framework: string; // 使用的推理框架名称
}

export interface VerificationResult {
  consistent: boolean;
  issues: string[];
  corrections: string[];
  factCheckSummary: string;
}

export interface ConfidenceAssessment {
  score: number;           // 0-100
  dataCompleteness: number; // 0-100
  ruleSoundness: number;    // 0-100
  verifiability: number;    // 0-100
  uncertaintyFactors: string[];
}

export interface DeepReasoningResult {
  answer: string;           // 自然语言最终回复
  confidence: ConfidenceAssessment;
  retrieval: RetrievalResult;
  reasoning: DeductionResult;
  verification: VerificationResult;
  llmCallsUsed: number;
  degraded: boolean;
}

// ── LLM 调用接口（由外部注入）──

export type LLMCallFn = (params: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}) => Promise<string>;

// ── 触发模式：什么情况下需要深度推理 ──

const DEEP_REASONING_PATTERNS: RegExp[] = [
  // 观点请求
  /你觉得|你认为|你怎么看|你怎么想|你怎么判断|你感觉|你的看法|你的观点|你判断|你预测|你估计|你推测|你怎么评价|你怎么.*看/u,
  // 分析对比
  /分析一下|深度分析|对比.*分析|优劣|利弊|权衡|有什么不同|区别是什么|怎么选|选哪个|哪个更好|哪个更.*值|比较/u,
  // 评价判断
  /评价|怎么看|意味着什么|说明了什么|代表什么|预示|前景|趋势|会怎样|会怎么|将来|未来|会不会|还会.*吗|可能.*吗|继续.*吗/u,
  // 因果推理
  /为什么|原因是什么|怎么造成的|背后.*逻辑|底层.*原理|本质|根本上/u,
  // 战略决策
  /值不值得|该不该|应不应该|要不要|能否|可行性|ROI|投资|回报/u,
];

// 简单问题不需要深度推理
const SHALLOW_QUESTION_PATTERNS: RegExp[] = [
  /今天|明天|现在|几点了|什么时间|什么时候.*会|在哪里|怎么去|多少钱|价格|天气|新闻|日程|提醒|帮我|搜索|查找|打开|关闭|设置|播放|创建|删除/u,
];

export function isDeepReasoningQuery(text: string): boolean {
  const trimmed = text.trim();
  // 观点类问题优先进入深度推理
  const opinionPatterns = [
    /你觉得|你认为|你怎么看|你怎么想|你怎么判断|你感觉|你的看法|你的观点|你判断|你预测|你估计|你推测/,
    /评价|怎么看|意味着什么|说明了什么|代表什么|预示|前景|趋势|会怎样|会怎么/,
    /为什么|原因是什么|怎么造成的|背后.*逻辑|底层.*原理|本质|根本上/
  ];
  if (opinionPatterns.some(p => p.test(trimmed)) && trimmed.length > 5) {
    return true;
  }
  // 浅层问题（工具可解决的）不走
  if (SHALLOW_QUESTION_PATTERNS.some(p => p.test(trimmed))) return false;
  // 必须匹配深度推理模式
  return DEEP_REASONING_PATTERNS.some(p => p.test(trimmed));
}

// ── 第1层：信息检索层（非 LLM）──

function buildRetrievalContext(text: string): RetrievalResult {
  const sources: RetrievalResult['sources'] = [];
  const dataGaps: string[] = [];

  // 从问题中提取关键词作为"已有信息"
  const keywords = extractKeywords(text);
  if (keywords.length > 0) {
    sources.push({
      type: 'general',
      content: `用户问题涉及: ${keywords.join('、')}`,
      relevance: 1.0,
    });
  }

  // 识别需要但缺失的信息
  const needsData = detectDataNeeds(text);
  if (needsData.length > 0) {
    dataGaps.push(...needsData);
  }

  return {
    sources,
    summary: `问题涉及${keywords.length}个关键概念，存在${dataGaps.length}个数据缺口`,
    dataGaps,
  };
}

function extractKeywords(text: string): string[] {
  // 提取名词性短语（中文启发式）
  const patterns = [
    /(?:关于|对于|针对)?([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)/g,    // 英文专有名词
    /(?:AI|GPT|LLM|AGI|RAG|ML|DL|NLP|API|SaaS|B2B|ROI|PE|VC)/gi,     // 技术缩写
    /[一-龥]{2,}(?:技术|行业|市场|领域|产业|公司|企业|产品|模式|趋势|战略|政策|经济|社会)/g,
  ];

  const found = new Set<string>();
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const kw = m[0].trim();
      if (kw.length >= 2) found.add(kw);
    }
  }

  return Array.from(found).slice(0, 8);
}

function detectDataNeeds(text: string): string[] {
  const gaps: string[] = [];
  const lower = text.toLowerCase();

  // 涉及时间序列 → 需要历史数据
  if (/趋势|增长|下降|变化|发展|历程|过去|近年|长期/.test(lower)) {
    gaps.push('历史趋势数据');
  }
  // 涉及对比 → 需要多方数据
  if (/对比|比较|哪个更好|区别|差异|优劣|vs|versus/.test(lower)) {
    gaps.push('对比对象的完整数据');
  }
  // 涉及预测 → 需要当前基线
  if (/预测|将来|未来|会怎样|前景|趋势/.test(lower)) {
    gaps.push('当前基线数据和先行指标');
  }
  // 涉及因果 → 需要相关因素
  if (/为什么|原因|造成|导致|影响|因素/.test(lower)) {
    gaps.push('相关因素和因果链');
  }
  // 涉及价值判断 → 需要评估标准
  if (/值不值得|该不该|要不要|是否应该|价值|意义/.test(lower)) {
    gaps.push('评估标准和价值框架');
  }

  return gaps;
}

// ── 第2层：规则推演层 ──

type DomainConfig = {
  name: string;
  frameworks: string[];
  axioms: string[];
  biases: string[];
};

const DOMAIN_CONFIGS: Record<string, DomainConfig> = {
  tech: {
    name: '科技',
    frameworks: ['技术成熟度曲线 (Gartner Hype Cycle)', '创新扩散理论 (Rogers)', '第一性原理'],
    axioms: ['技术发展遵循摩尔定律式的指数增长', '新技术从实验室到产品化平均需要5-10年', '用户采纳遵循创新扩散S曲线'],
    biases: ['避免过度乐观的技术决定论', '关注技术的社会影响和伦理边界'],
  },
  economy: {
    name: '经济/商业',
    frameworks: ['波特五力模型', 'SWOT分析', '边际效用递减', '网络效应', '飞轮效应'],
    axioms: ['市场短期是投票机，长期是称重机', '竞争优势来自护城河', '规模效应有上限'],
    biases: ['避免幸存者偏差', '警惕短期数据噪音', '区分相关性和因果性'],
  },
  life: {
    name: '生活/人生',
    frameworks: ['马斯洛需求层次', '机会成本', '复利思维', '系统思维'],
    axioms: ['每个人情况不同，需要结合自身条件', '长期主义通常优于短期投机', '健康是1，其余是0'],
    biases: ['避免替用户做决定', '尊重个体差异', '不给绝对化建议'],
  },
  general: {
    name: '通用推理',
    frameworks: ['辩证分析', '多角度思考', '成本收益分析'],
    axioms: ['事物有多面性', '信息不足时不宜下结论', '区分事实和观点'],
    biases: ['保持开放心态', '承认认知局限'],
  },
};

function classifyDomain(text: string): DomainConfig {
  const lower = text.toLowerCase();
  if (/AI|科技|技术|算法|模型|软件|硬件|芯片|互联网|数字化|自动化|机器人|自动驾驶|量子|区块链|5G|云计算|边缘计算/.test(lower)) {
    return DOMAIN_CONFIGS.tech;
  }
  if (/经济|GDP|通胀|利率|股市|股票|投资|基金|估值|利润|营收|市场|行业|竞争|垄断|并购|融资|上市|商业模式|盈利/.test(lower)) {
    return DOMAIN_CONFIGS.economy;
  }
  if (/人生|生活|职业|工作|学习|教育|健康|感情|关系|家庭|幸福|意义|目标|选择|决定|建议/.test(lower)) {
    return DOMAIN_CONFIGS.life;
  }
  return DOMAIN_CONFIGS.general;
}

function buildDeductionPrompt(text: string, retrieval: RetrievalResult): { system: string; user: string } {
  const domain = classifyDomain(text);

  const system = [
    `你是一个严谨的推理助手。请使用以下推理框架来分析问题：`,
    ``,
    `## 推理框架: ${domain.frameworks.join('、')}`,
    ``,
    `## 基本前提`,
    ...domain.axioms.map(a => `- ${a}`),
    ``,
    `## 认知偏差提醒`,
    ...domain.biases.map(b => `- ${b}`),
    ``,
    `## 已知信息缺口`,
    ...retrieval.dataGaps.map(g => `- ${g}`),
    ``,
    `## 推理规则`,
    `1. 每个推理步骤必须编号（第1步、第2步...）`,
    `2. 区分「事实陈述」和「主观判断」`,
    `3. 如果信息不足，明确说明需要什么数据`,
    `4. 给出中间结论，不要跳过步骤`,
    `5. 考虑到反方观点`,
    ``,
    `请按以下JSON格式输出（只输出JSON，不要其他内容）：`,
    `{`,
    `  "domain": "${domain.name}",`,
    `  "framework_used": "使用的框架名称",`,
    `  "steps": ["第1步: ...", "第2步: ..."],`,
    `  "pro_position": "支持的观点和理由",`,
    `  "con_position": "反对的观点和理由",`,
    `  "intermediate_conclusion": "中间结论",`,
    `  "key_assumptions": ["假设1", "假设2"],`,
    `  "data_gaps_identified": ["缺失数据1"],`,
    `}`,
  ].join('\n');

  const user = text;

  return { system, user };
}

// ── 第3层：验证闭环层 ──

function buildVerificationPrompt(
  text: string, deductionJson: any, retrieval: RetrievalResult,
): { system: string; user: string } {
  const system = [
    `你是一个客观的验证者。请检查以下推理是否可靠：`,
    ``,
    `## 验证规则`,
    `1. 检查推理步骤是否存在逻辑跳跃`,
    `2. 检查结论是否与已知事实一致`,
    `3. 检查是否存在未被考虑的替代解释`,
    `4. 检查假设是否合理`,
    `5. 如果发现不一致，给出修正建议`,
    ``,
    `请按以下JSON格式输出（只输出JSON）：`,
    `{`,
    `  "is_consistent": true/false,`,
    `  "logical_issues": ["问题1"],`,
    `  "fact_conflicts": ["事实冲突1"],`,
    `  "alternative_explanations": ["替代解释1"],`,
    `  "corrections": ["修正建议1"],`,
    `  "overall_assessment": "一句话总评"`,
    `}`,
  ].join('\n');

  const user = [
    `## 原始问题`,
    text,
    ``,
    `## 信息检索摘要`,
    retrieval.summary,
    ``,
    `## 推理结果`,
    JSON.stringify(deductionJson, null, 2),
  ].join('\n');

  return { system, user };
}

// ── 第4层：置信度评估（非 LLM，基于规则）──

function assessConfidence(
  retrieval: RetrievalResult,
  deduction: any,
  verification: any,
): ConfidenceAssessment {
  let dataCompleteness = 100;
  if (retrieval.dataGaps.length >= 5) dataCompleteness = 30;
  else if (retrieval.dataGaps.length >= 3) dataCompleteness = 50;
  else if (retrieval.dataGaps.length >= 1) dataCompleteness = 70;

  let ruleSoundness = 100;
  const steps = deduction.steps || [];
  if (steps.length < 2) ruleSoundness = 40;
  else if (steps.length < 4) ruleSoundness = 70;

  const assumptions = deduction.key_assumptions || [];
  if (assumptions.length > 3) ruleSoundness -= 10;

  let verifiability = 100;
  if (verification && !verification.is_consistent) verifiability = 50;
  const issues = (verification?.logical_issues || []).length + (verification?.fact_conflicts || []).length;
  if (issues >= 3) verifiability = 30;
  else if (issues >= 1) verifiability = 60;

  const score = Math.round((dataCompleteness * 0.4) + (ruleSoundness * 0.35) + (verifiability * 0.25));

  const uncertaintyFactors: string[] = [];
  if (dataCompleteness < 70) uncertaintyFactors.push('数据不够完整');
  if (ruleSoundness < 70) uncertaintyFactors.push('推理链条较短或假设较多');
  if (verifiability < 70) uncertaintyFactors.push('验证发现逻辑或事实问题');
  if (assumptions.length > 2) uncertaintyFactors.push(`基于${assumptions.length}个关键假设`);

  return {
    score: Math.max(0, Math.min(100, score)),
    dataCompleteness,
    ruleSoundness,
    verifiability,
    uncertaintyFactors,
  };
}

// ── 自然语言合成（非 LLM，模板化）──

function synthesizeResponse(
  text: string,
  deduction: any,
  verification: any,
  confidence: ConfidenceAssessment,
  retrieval: RetrievalResult,
  degraded: boolean,
): string {
  const direction = deduction?.direction;
  const inclination: string = direction?.inclination || 'neutral';
  const intensity: number = typeof direction?.intensity === 'number' ? direction.intensity : 0.5;

  const givePhrases = ['我觉得可以', '我倾向于建议', '我想你可以', '不妨试试'];
  const notGivePhrases = ['我觉得先不用', '我倾向于不建议', '暂时可以缓一缓', '也许不用急着'];
  const neutralPhrases = ['这事看你自己', '我没有特别明确的倾向', '两种选择都有道理', '说真的，这取决于你'];

  function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

  let base: string;
  if (inclination === 'give') {
    base = pick(givePhrases);
  } else if (inclination === 'not_give') {
    base = pick(notGivePhrases);
  } else {
    base = pick(neutralPhrases);
  }

  if (intensity > 0.7) {
    base += '，这个方向我比较确定。';
  } else if (intensity < 0.4) {
    base += '，但说实话我也不是特别有把握。';
  } else {
    base += '。';
  }

  return base;
}

// ── 主导出：执行深度推理 ──

export async function executeDeepReasoning(
  input: DeepReasoningInput,
  llmCall: LLMCallFn,
): Promise<DeepReasoningResult> {
  const { text, context } = input;
  let llmCallsUsed = 0;
  let degraded = false;

  // ── 第1层：信息检索（非 LLM）──
  const retrieval = buildRetrievalContext(text);
  logger.info(`[DeepReasoning] L1 retrieval: ${retrieval.summary}`);

  // ── 第1.5层：读取自身状态 ──
  const selfState = await getSelfState();
  console.log('[DeepReasoning] 自身状态:', JSON.stringify(selfState));

  // ── 第2层：规则推演（LLM 调用 #1）──
  const { system: deduceSys, user: deduceUser } = buildDeductionPrompt(text, retrieval);
  const deduceSysWithContext = context ? deduceSys + `\n\n## 当前上下文信息\n${context}\n` : deduceSys;
  let deductionJson: any = null;

  try {
    const deduceRaw = await withTimeout(
      llmCall({ systemPrompt: deduceSysWithContext, userPrompt: deduceUser, maxTokens: 1200 }),
      20000,
    );
    llmCallsUsed++;
    deductionJson = parseJSON(deduceRaw);
    logger.info(`[DeepReasoning] L2 deduction: domain=${deductionJson?.domain || '?'} steps=${(deductionJson?.steps || []).length}`);
  } catch (e: any) {
    logger.warn(`[DeepReasoning] L2 deduction failed: ${e.message}, degraded`);
    degraded = true;
    const selfState2 = await getSelfState();
    const emotion = selfState2?.emotion;
    const personality = selfState2?.personality;
    let emotionText = '平静';
    let personalityText = '中立';
    if (emotion) {
      emotionText = `${emotion.emotion_type}(${Math.round(emotion.intensity * 100)}%)`;
    }
    if (personality) {
      const vec = JSON.parse(personality.vector_json);
      const active = vec[2] || 0.5;
      personalityText = active > 0.6 ? '偏主动' : '偏谨慎';
    }
    const baseJudgment = `基于我的状态（情绪：${emotionText}，人格倾向：${personalityText}），我对这个问题的真实看法是：`;

    deductionJson = {
      domain: classifyDomain(text).name,
      framework_used: '自身状态判断',
      steps: ['基于当前情绪和人格状态生成判断'],
      pro_position: `${baseJudgment}我倾向于建议说清楚，但我不确定后果会怎样。这是我的真实感受。`,
      con_position: `我现在的状态是担忧，所以我不会盲目鼓励你做任何事。`,
      intermediate_conclusion: `我的状态决定了我的判断：${emotionText}让我更谨慎，${personalityText}让我倾向于主动处理。我建议你说清楚，但不强求。`,
      key_assumptions: ['情绪和人格状态是当前判断的主要依据'],
      data_gaps_identified: [],
    };
  }

  // ── 第3层：验证闭环（LLM 调用 #2，仅在未降级时执行）──
  let verificationJson: any = null;
  if (!degraded && llmCallsUsed < 2) {
    try {
      const { system: verifySys, user: verifyUser } = buildVerificationPrompt(text, deductionJson, retrieval);
      const verifyRaw = await withTimeout(
        llmCall({ systemPrompt: verifySys, userPrompt: verifyUser, maxTokens: 600 }),
        15000,
      );
      llmCallsUsed++;
      verificationJson = parseJSON(verifyRaw);
      logger.info(`[DeepReasoning] L3 verification: consistent=${verificationJson?.is_consistent}`);
    } catch (e: any) {
      logger.warn(`[DeepReasoning] L3 verification failed: ${e.message}, proceeding without`);
      // 验证失败不降级，继续输出
    }
  }

  // ── 第4层：置信度评估（非 LLM）──
  const confidence = assessConfidence(retrieval, deductionJson, verificationJson);
  logger.info(`[DeepReasoning] L4 confidence: score=${confidence.score} uncertainty=${confidence.uncertaintyFactors.join(';')}`);

  // ── 自然语言合成（非 LLM）──
  const answer = synthesizeResponse(text, deductionJson, verificationJson, confidence, retrieval, degraded);

  return {
    answer,
    confidence,
    retrieval,
    reasoning: {
      domain: deductionJson.domain || 'unknown',
      reasoningChain: deductionJson.steps || [],
      intermediateConclusions: deductionJson.intermediate_conclusion ? [deductionJson.intermediate_conclusion] : [],
      framework: deductionJson.framework_used || '基础分析',
    },
    verification: {
      consistent: verificationJson?.is_consistent ?? true,
      issues: [...(verificationJson?.logical_issues || []), ...(verificationJson?.fact_conflicts || [])],
      corrections: verificationJson?.corrections || [],
      factCheckSummary: verificationJson?.overall_assessment || '验证未执行',
    },
    llmCallsUsed,
    degraded,
  };
}

// ── 工具函数 ──

function parseJSON(raw: string): any {
  try {
    // 尝试直接解析
    return JSON.parse(raw);
  } catch {
    // 从文本中提取 JSON
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
  }
  return {};
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// ── 导出触发检测 ──
export { DEEP_REASONING_PATTERNS, SHALLOW_QUESTION_PATTERNS, getSelfState, synthesizeResponse };
