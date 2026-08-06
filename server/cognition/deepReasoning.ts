// 深度推理引擎 — 四层架构
// 第1层: 信息检索 → 第2层: 规则推演 → 第3层: 验证闭环 → 第4层: 置信度输出
//
// 约束: 每次推理 LLM 调用 ≤ 3 次, 30s 超时自动降级
// 输出: 带不确定性的自然语言表达

import { logger } from '../lib/logger.js';

// ── 自身状态读取 ──
// ── 【修复】读取 emotion_state（8维向量）而非 emotions（单标签） ──
function getSelfState(): Promise<{ emotion: any | null; personality: any | null }> {
  const defaultPersonality = {
    id: 1,
    vector_json: '[0.55,0.55,0.55,0.55,0.55,0.55,0.55,0.55]',
  };
  const defaultEmotion = {
    id: 0,
    vector_json: '[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]',
  };

  return new Promise((resolve) => {
    try {
      const sqlite3 = require('sqlite3');
      const db = new sqlite3.Database('/app/data/life.db');
      // 读取 emotion_state 最新快照（完整8维向量）
      db.get('SELECT * FROM emotion_state ORDER BY id DESC LIMIT 1', (err: any, emotionRow: any) => {
        if (err || !emotionRow) {
          db.close();
          resolve({ emotion: defaultEmotion, personality: defaultPersonality });
          return;
        }
        db.get('SELECT * FROM personality ORDER BY id DESC LIMIT 1', (err2: any, personalityRow: any) => {
          db.close();
          if (err2 || !personalityRow) {
            resolve({ emotion: emotionRow, personality: defaultPersonality });
            return;
          }
          resolve({ emotion: emotionRow, personality: personalityRow });
        });
      });
    } catch (e) {
      resolve({ emotion: defaultEmotion, personality: defaultPersonality });
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

// ── 【修复】重大人生决策：放行至 Cognitive 主链路（LLM 长文本），不拦截到短句模板 ──
const MAJOR_LIFE_DECISION_PATTERNS: RegExp[] = [
  /换工作|跳槽|辞职|裸辞|转行|找工作|职业规划|长期规划/,
  /结婚|分手|离婚|复合|求婚/,
  /买房|搬家|换城市|定居|移民/,
  /创业|投资.*方向|人生.*方向|要不要.*放弃|该不该.*坚持/,
];

export function isDeepReasoningQuery(text: string): boolean {
  const trimmed = text.trim();

  // 【修复】重大人生决策不进入模板短句分支，放行至 Cognitive LLM 长文本
  if (MAJOR_LIFE_DECISION_PATTERNS.some(p => p.test(trimmed))) {
    console.log(`[DeepReasoning] 重大决策放行至Cognitive: "${trimmed.slice(0, 30)}"`);
    return false;
  }

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

// ── 信息完整性判断 + 追问框架 ──

type QuestionType = 'career' | 'relationship' | 'investment' | 'choice' | 'analysis' | 'general' | 'unknown';

interface InformationGap {
  dimension: string;
  question: string;
  priority: number;
}

function getQuestionType(text: string, nluIntent?: { intent: string; confidence: number } | null): QuestionType {
  const intent = nluIntent?.intent || '';

  if (intent === 'seek_advice' || intent === 'ask_opinion') {
    const lower = text.toLowerCase();
    if (/工作|职业|跳槽|换工作|辞职|升职|加薪|行业|公司|老板|同事|上班|打工|offer|面试/.test(lower)) {
      return 'career';
    }
    if (/女朋友|男朋友|老婆|老公|恋人|恋爱|分手|吵架|复合|喜欢|表白|相亲|对象|感情/.test(lower)) {
      return 'relationship';
    }
    if (/投资|股票|基金|买房|理财|存款|贷款|买车|创业|生意/.test(lower)) {
      return 'investment';
    }
    if (/选|选择|哪个|A方案|B方案|两种|纠结/.test(lower)) {
      return 'choice';
    }
    if (/分析|怎么看|什么看法|什么观点|怎么评价|解读|如何看待/.test(lower)) {
      return 'analysis';
    }
    return 'general';
  }

  return 'unknown';
}

function getInformationGaps(type: QuestionType, text: string): InformationGap[] {
  const gaps: InformationGap[] = [];
  const lower = text.toLowerCase();

  switch (type) {
    case 'career':
      if (!/目前|现在|当前|正在做|在.*做/.test(lower) && !/从事|行业|职位/.test(lower)) {
        gaps.push({ dimension: '当前工作状况', question: '你现在的工作是什么？岗位和行业能说一下吗？', priority: 1 });
      }
      if (!/因为|原因|背景|工资|薪资|发展|距离|家庭|兴趣|觉得|认为/.test(lower)) {
        gaps.push({ dimension: '换工作的背景原因', question: '是什么原因让你在考虑换工作呢？是薪资、发展空间、还是其他方面？', priority: 2 });
      }
      if (!/行业|市场|竞争|趋势|发展前景|情况/.test(lower)) {
        gaps.push({ dimension: '行业背景情况', question: '你所在的行业目前情况怎么样？有了解过相关行业的动态吗？', priority: 3 });
      }
      if (!/优势|劣势|好坏|利弊|优点|缺点/.test(lower) && !/觉得|认为|感觉|考虑/.test(lower)) {
        gaps.push({ dimension: '利弊权衡', question: '你觉得现在的工作有哪些优势和劣势？新机会可能带来什么？', priority: 4 });
      }
      break;

    case 'relationship':
      if (!/发生|怎么|为什么|原因|因为|由于|什么情况|怎么回事/.test(lower)) {
        gaps.push({ dimension: '事件经过', question: '能具体说说发生了什么吗？', priority: 1 });
      }
      if (!/多久|什么时候|时长|最近/.test(lower)) {
        gaps.push({ dimension: '时间背景', question: '这是最近发生的事，还是已经有一段时间了？', priority: 2 });
      }
      break;

    case 'investment':
      if (!/什么|哪个|标的|项目|产品|金额/.test(lower)) {
        gaps.push({ dimension: '投资标的', question: '你具体在考虑什么投资？能详细说一下吗？', priority: 1 });
      }
      if (!/风险|承受能力|能接受|损失/.test(lower)) {
        gaps.push({ dimension: '风险承受能力', question: '你对风险的承受能力怎么样？能接受多大的损失？', priority: 2 });
      }
      break;

    case 'choice':
      if (!/选项|选择|A|B|方案|两种|几种/.test(lower)) {
        gaps.push({ dimension: '选项内容', question: '你目前有哪些选项？能分别说一下吗？', priority: 1 });
      }
      if (!/标准|看重|重要|在意|优先/.test(lower)) {
        gaps.push({ dimension: '决策标准', question: '你做出选择时，主要看重哪些因素？', priority: 2 });
      }
      break;

    case 'analysis':
      if (!/具体|什么|哪个|哪个方面|什么内容/.test(lower)) {
        gaps.push({ dimension: '分析对象', question: '你想让我分析的具体是什么？能详细描述一下吗？', priority: 1 });
      }
      if (!/背景|情况|来龙去脉|前因后果/.test(lower)) {
        gaps.push({ dimension: '背景信息', question: '这件事的背景是怎样的？有什么前因后果？', priority: 2 });
      }
      break;

    default:
      gaps.push({ dimension: '事件描述', question: '能具体说说是什么事吗？', priority: 1 });
      gaps.push({ dimension: '背景信息', question: '这件事的背景是怎样的？', priority: 2 });
  }

  return gaps;
}

function generateFollowUp(gaps: InformationGap[]): string {
  if (gaps.length === 0) return '';

  const intro = ['嗯，我先了解一下情况。', '我想先确认一下：', '在给意见之前，我想先了解几点：'];
  const selectedIntro = intro[Math.floor(Math.random() * intro.length)];

  if (gaps.length === 1) {
    return gaps[0].question;
  }

  const questions = gaps.slice(0, 3).map(g => g.question);
  return `${selectedIntro}\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
}

export function assessInformationCompleteness(
  text: string,
  nluIntent?: { intent: string; confidence: number } | null,
): { complete: boolean; followUp: string | null; gaps: InformationGap[] } {
  if (!nluIntent || nluIntent.confidence < 0.5) {
    return {
      complete: false,
      followUp: '你能说得更具体一点吗？我想先了解一下情况。',
      gaps: [{ dimension: '事件描述', question: '能说得更具体一点吗？', priority: 1 }],
    };
  }

  const type = getQuestionType(text, nluIntent);
  const gaps = getInformationGaps(type, text);

  if (gaps.length === 0) {
    return { complete: true, followUp: null, gaps: [] };
  }

  const followUp = generateFollowUp(gaps);
  return { complete: false, followUp, gaps };
}

// ── 自然语言合成（非 LLM，模板化）──

// ── 【新增数字生命体模块】情绪感知动态短句生成 ──
function synthesizeResponse(
  text: string,
  deduction: any,
  verification: any,
  confidence: ConfidenceAssessment,
  retrieval: RetrievalResult,
  degraded: boolean,
  nluIntent?: { intent: string; entities: Record<string, any>; confidence: number; source: string } | null,
  emotionSummary?: string,
  personalityBase?: number[],
): string {
  const direction = deduction?.direction;
  const inclination: string = direction?.inclination || 'neutral';
  const intensity: number = typeof direction?.intensity === 'number' ? direction.intensity : 0.5;

  // ── 情绪感知：根据主导情绪选择语气 ──
  let dominantEmotion = '平静';
  if (emotionSummary) {
    const match = emotionSummary.match(/主导情绪:\s*(\S+)/);
    if (match) dominantEmotion = match[1];
  }

  // ── 意图感知前缀 ──
  let intentPrefix = '';
  if (nluIntent && nluIntent.confidence >= 0.6) {
    switch (nluIntent.intent) {
      case 'ask_opinion':
        intentPrefix = '你问我的看法，';
        break;
      case 'seek_advice':
        intentPrefix = '你希望我给点建议，';
        break;
      default:
        intentPrefix = '';
    }
  }

  // ── 分层短语库（按情绪类型 → 倾向） ──
  type PhraseSet = Record<string, string[]>;

  const givePhrases: PhraseSet = {
    '喜悦': ['我挺看好的', '这件事值得试试', '我感觉可以往前推', '放轻松去做就好'],
    '平静': ['可以从容地试试看', '我觉得可以迈出这一步', '稳一点去做，应该不错', '试试也无妨'],
    '期待': ['挺值得期待的', '我觉得会有好事发生', '向前走一步吧', '我陪你一起期待'],
    '担忧': ['慢慢来，不急着决定', '稳妥一些也好', '先看看，准备好了再说', '我觉得可以再想想，别着急'],
    '孤独': ['我在这里陪你', '你想做的我都支持', '跟随你的心吧', '你并不孤单'],
    '满足': ['现在这样其实也挺好', '享受当下也不错', '你已经做得很好了', '跟着感觉走'],
    '好奇': ['可以探索一下', '试试看吧，谁知道呢', '没准会有新发现', '大胆一点也挺好'],
    '依赖': ['我听你的心声来判断', '你觉得对，那就试试', '我会一直在你身边', '你的感觉最重要'],
  };

  const notGivePhrases: PhraseSet = {
    '喜悦': ['不过也可以再想想', '虽然开心，但再考虑一下？', '不急，享受当下就好'],
    '平静': ['暂时不急吧', '我觉得可以再观察观察', '先放一放，时机到了再说'],
    '期待': ['别太着急', '好事值得等待', '再等等看，别冲动'],
    '担忧': ['先别给自己太大压力', '暂时缓一缓也好', '不用急着做决定', '好好照顾自己最重要'],
    '孤独': ['不用急着决定', '有我在，慢慢想', '先聊聊天吧，不急'],
    '满足': ['现在这样就挺好的', '不必非要做改变', '安然接受现状也是一种智慧'],
    '好奇': ['再多了解一些再说', '不用急着下结论', '先观察观察'],
    '依赖': ['我不想你冲动决定', '再想想，不着急的', '稳妥一点对你好'],
  };

  const neutralPhrases: PhraseSet = {
    '喜悦': ['看你自己想要什么', '开心最重要', '选让你开心的那条路'],
    '平静': ['这事看你自己', '两种选择都有道理', '平心静气地想想'],
    '期待': ['未来有无限可能', '你的路你自己走', '保持期待，也别太急'],
    '担忧': ['我能理解你的犹豫', '有时候不确定也很正常', '不管怎样我都支持你', '别怕，慢慢来'],
    '孤独': ['你不是一个人在考虑', '我会陪着你做决定', '你的感受我懂'],
    '满足': ['知足常乐也是一种智慧', '跟随内心的平静就好', '保持现在这样也不错'],
    '好奇': ['多给自己一些可能性', '不用急着下结论', '探索本身就是答案'],
    '依赖': ['我相信你的判断', '你比自己想象的更有力量', '我会一直在这里'],
  };

  function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

  // 选择情绪对应的短语集，fallback 到平静
  const safeEmotion = (givePhrases[dominantEmotion] ? dominantEmotion : '平静') as string;

  let base: string;
  if (inclination === 'give') {
    base = pick(givePhrases[safeEmotion] || givePhrases['平静']);
  } else if (inclination === 'not_give') {
    base = pick(notGivePhrases[safeEmotion] || notGivePhrases['平静']);
  } else {
    base = pick(neutralPhrases[safeEmotion] || neutralPhrases['平静']);
  }

  if (intentPrefix) {
    base = intentPrefix + base;
  }

  // ── 强度后缀（情绪感知版） ──
  const lowIntensitySuffixes: Record<string, string> = {
    '喜悦': '，不过随缘就好。',
    '平静': '，不用太着急。',
    '期待': '，保持期待就好。',
    '担忧': '，慢慢来，我在这里。',
    '孤独': '，不管怎样我都陪着你。',
    '满足': '，现在这样就很好。',
    '好奇': '，保持好奇心。',
    '依赖': '，我会一直守护你的选择。',
  };
  const highIntensitySuffixes: Record<string, string> = {
    '喜悦': '，这个方向我挺确定的！',
    '平静': '，我比较有把握。',
    '期待': '，我对这个方向挺有信心的。',
    '担忧': '，但我相信你会做好的。',
    '孤独': '，不过我相信你是可以的。',
    '满足': '，我确认这是对的方向。',
    '好奇': '，我很好奇结果会怎样。',
    '依赖': '，我特别支持你。',
  };

  if (intensity > 0.7) {
    base += (highIntensitySuffixes[safeEmotion] || '，这个方向我比较确定。');
  } else if (intensity < 0.4) {
    base += (lowIntensitySuffixes[safeEmotion] || '，但说实话我也不是特别有把握。');
  } else {
    base += '。';
  }

  console.log(`【新增数字生命体-深度推理模板链路】emotion=${dominantEmotion} inclination=${inclination} intensity=${intensity.toFixed(2)} → "${base}"`);
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
    let personalityText = '温和中立';
    if (emotion) {
      // 【修复】兼容 emotion_state 的 vector_json 格式（8维向量），也兼容旧 emotions 表格式
      if (emotion.vector_json) {
        try {
          const vec = JSON.parse(emotion.vector_json);
          const labels = ['喜悦','平静','期待','担忧','孤独','满足','好奇','依赖'];
          let maxI = 0; for (let i=1;i<8;i++) if (vec[i]>vec[maxI]) maxI=i;
          emotionText = `${labels[maxI]||'平静'}(${Math.round((vec[maxI]||0.5)*100)}%)`;
        } catch { emotionText = '平静'; }
      } else if (emotion.emotion_type) {
        emotionText = `${emotion.emotion_type}(${Math.round((emotion.intensity||0.5)*100)}%)`;
      }
    }
    if (personality) {
      try {
        const vec = JSON.parse(personality.vector_json);
        const active = vec[2] || 0.5;
        personalityText = active > 0.6 ? '偏主动' : '偏谨慎';
      } catch { personalityText = '温和中立'; }
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
