// 阶段一·模块3: 深度认知工具 — 并行多路径因果推理（多推演链路交叉校验降幻觉）
// 独立注册：LLM 在深度推理场景主动调用；E2E 直接调用 handler 校验交叉校验算法。
import { ToolRegistry } from '../registry';
import { logger } from '../../lib/logger';
import { multiPathReason, formatReasonReport } from '../../cognition/multi_path_reasoner';

async function cognitiveReason(args: Record<string, any>, userId: string): Promise<string> {
  const question = String(args.question || '').trim();
  if (!question) throw new Error('question 为必填（需推演的因果/假设问题）');

  // 注入运行时 LLM（chat handler 注册时写入 global.__llmGetters）；无可用模型时纯结构降级
  const g = ((global as any).__llmGetters || {}) as Record<string, (() => any) | undefined>;
  const getter = (name: string): (() => any) => g[name] || (() => null);
  const llm = async (perspective: string, prompt: string, q: string) => {
    const model = getter('getDeepSeek')() || getter('getGemini')();
    if (!model) return null;
    try {
      const r = await model.call(q, { systemPrompt: `${prompt}\n请以「${perspective}」视角回答：结论一句话（20字内）；推演摘要（30字内）；疑点（最多2条，用「疑点:」开头分行）。` });
      const s = String(r?.text || r || '');
      if (!s.trim()) return null;
      const caveats = (s.match(/疑点[:：]\s*([^\n]+)/) || [])[1]?.split(/[；;]/).slice(0, 2) || [];
      return {
        conclusion: s.split('\n')[0].replace(/^(结论|推演)[:：]?\s*/, '').slice(0, 60),
        confidence: 0.6,
        reasoning: s.slice(0, 150),
        caveats,
      };
    } catch {
      return null;
    }
  };

  const output = await multiPathReason(question, { llm, timeoutMs: 45000 });
  logger.info(`[CognitionTools] cognitive_reason "${question.slice(0, 30)}" → ${output.verdict}`);
  return `🧠 并行多路径因果推理（${output.paths.length} 条链路并行交叉校验）:\n` + formatReasonReport(output);
}

export function registerCognitionTools(registry: ToolRegistry): void {
  registry.register({
    name: 'cognitive_reason',
    description:
      '并行多路径因果推理：同一问题走 理性实证/反面证伪/多因合流 三条独立链路并行推演，交叉校验后输出：链路一致→共识结论+置信度；链路分歧→并列各方观点+待核实要点，不武断下结论（降幻觉）。适合 为什么/如果…会怎样/原因分析/预测 类问题',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '需要推演的因果/假设问题，如「为什么今年夏天异常炎热」' },
      },
      required: ['question'],
    },
    handler: async (args: Record<string, any>) => cognitiveReason(args, String(args.userId || process.env.E2E_UID || 'peppa-user')),
    permission: 'user',
    securityLevel: 'safe',
  });
  logger.info('[CognitionTools] 已注册 cognitive_reason（多路径交叉校验）');
}
