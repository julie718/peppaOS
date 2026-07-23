import { Router } from "express";
import { logger } from '../lib/logger';
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { checkLLMAccess, recordUsage, estimateTokens } from "../subscription/proxy";
import { runWithTools } from "../llm/adapter";
import { makeLLMCall } from "../llm/providers";
import { toolRegistry } from "../tools/registry";
import { recordLatency } from "../monitor/latency_store";
import { optionalAuth } from "../middleware/auth";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { recordTokenUsage } from "../llm/token_tracker";
import { queryMemoriesVector } from "../memory/store";
import { loadEmotionalState } from "../personality/state";
import { getSensory } from "../socket/shared";
import { readDB, writeDB } from "../../db_layer";

export function mountChatRoutes(router: Router, _jwtSecret: string, llm: {
  getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
}) {
  const asyncHandler = (fn: (req: any, res: any, next?: any) => Promise<any>) =>
    (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);

  const handleChat = asyncHandler(async (req, res) => {
    const { provider: reqProvider = "gemini", model: reqModel, messages, prompt: rawPrompt, message } = req.body;
    const prompt = rawPrompt ?? message;
    const userKey = req.headers["x-api-key"] as string;
    const userId = req.user?.uid || 'anonymous';

    const isBYOK = userKey && userKey.length > 5;
    const preferred = getUserPreferredLLMConfig(userId);
    const provider = isBYOK ? reqProvider : preferred.provider;
    const model = isBYOK ? reqModel : preferred.model;
    if (!isBYOK && reqProvider && reqProvider !== provider) {
      logger.warn(`[Chat] Ignoring request provider ${reqProvider}; using primary brain ${provider}/${model} for user ${userId}`);
    }

    if (!isBYOK) {
      const access = checkLLMAccess({ userId, provider, model: model || '' });
      if (!access.allowed) {
        return res.status(402).json({ error: access.reason, code: access.tokenLimitReached ? 'TOKEN_LIMIT' : 'PROVIDER_RESTRICTED' });
      }
    }

    try {
      let responseText = '';

      // 持久化辅助函数
      const persistInteraction = (text: string) => {
        try {
          const db = readDB();
          if (!db.interactions) db.interactions = [];
          db.interactions.push({
            id: `rest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            userId, agentId: 'peppa', module: 'chat_routes',
            message: prompt || '', response: text,
            role: 'user', personality: 'peppa',
            timestamp: new Date().toISOString(),
            cognitiveIntent: 'conversation',
            llmWasCalled: true,
            domain: 'personal', orgId: '',
          });
          writeDB(db);
        } catch {}
      };

      // ── 检查客户端是否已传入 system prompt（如 runAgentLogic 传来的）──
      const clientSystemMsg = messages?.find((m: any) => m.role === 'system');
      const baseSystemPrompt = clientSystemMsg?.content
        || "你是 Peppa（佩奇），一个温暖、有好奇心、有个性的 AI 伙伴。你不是冷冰冰的工具，你是朋友。用中文回复，语气自然亲切，像朋友聊天一样。回复简洁，控制在 200 字以内。如果不知道答案就诚实说不知道。";

      // ── 注入记忆和情绪上下文（与 WebSocket 路径对齐）──
      let contextSuffix = '';
      try {
        const [memories, emotionalState] = await Promise.all([
          queryMemoriesVector({ userId, query: prompt || message || '', limit: 5 }).catch(() => []),
          (async () => {
            try { return loadEmotionalState(`emotion_${userId}`); } catch { return null; }
          })(),
        ]);
        if (memories && memories.length > 0) {
          const memLines = memories.slice(0, 5).map((m: any, i: number) =>
            `${i + 1}. ${m.content?.slice(0, 150) || ''}`
          );
          contextSuffix += '\n\n## 相关记忆\n' + memLines.join('\n');
        }
        if (emotionalState) {
          const es = emotionalState as any;
          contextSuffix += `\n\n## 当前情绪\n${es.dominantMood || '平静'}, 连接感: ${(es.connection || 0).toFixed(2)}`;
        }
        try {
          const sensory = getSensory(userId);
          if (sensory && (sensory as any).sceneLabel) {
            const s = sensory as any;
            contextSuffix += `\n\n## 场景感知\n场景: ${s.sceneLabel || '未知'}, 环境: ${s.environmentType || '未知'}`;
          }
        } catch {}
      } catch {}

      const systemInstruction = baseSystemPrompt + contextSuffix;

      if (isBYOK) {
        const llmStart = Date.now();
        if (provider === "gemini") {
          const client = new GoogleGenerativeAI(userKey);
          const modelInstance = client.getGenerativeModel({ model: model || "gemini-2.0-flash", systemInstruction });
          const contents = messages
            ? messages.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
            : [{ role: 'user', parts: [{ text: prompt }] }];
          responseText = (await modelInstance.generateContent({ contents })).response.text();
        } else if (provider === "anthropic") {
          const client = new Anthropic({ apiKey: userKey });
          const response = await client.messages.create({
            model: model || "claude-sonnet-4-6", max_tokens: 1024,
            messages: messages || [{ role: "user", content: prompt }]
          });
          responseText = response.content[0].type === 'text' ? response.content[0].text : '';
        } else {
          const client = new OpenAI({ apiKey: userKey, baseURL: provider === "deepseek" ? "https://api.deepseek.com/v1" : provider === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : undefined });
          const response = await client.chat.completions.create({
            model: model || (provider === "deepseek" ? "deepseek-chat" : provider === "qwen" ? "qwen-plus" : "gpt-4o"),
            messages: messages || [{ role: "user", content: prompt }]
          });
          responseText = response.choices[0].message.content || '';
        }
        recordLatency('llm', Date.now() - llmStart);
        persistInteraction(responseText);
      } else {
        // 使用单一 system prompt（客户端传入的或默认 Peppa 人格），过滤客户端 system 消息避免重复
        const filteredClientMessages = (messages || [{ role: 'user', content: prompt }])
          .filter((m: any) => m.role !== 'system');
        const normalizedMessages: any[] = [
          { role: 'system', content: systemInstruction },
          ...filteredClientMessages.map((m: any) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content || ''
          }))
        ];

        const stream = req.query.stream === 'true';

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          const result = await runWithTools(
            normalizedMessages,
            toolRegistry,
            { provider, model, userId },
            undefined, 3,
            llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
            (chunk) => {
              res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
            },
          );

          responseText = result.text || '';
          const tokens = estimateTokens(
            normalizedMessages.map((m: any) => m.content || '').join(' ') + ' ' + responseText
          );
          for (const u of result.usageRecords || []) {
            recordTokenUsage(userId, u.provider, u.model, {
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              totalTokens: u.totalTokens,
            }, `rest_chat_${Date.now()}`, 'chat');
          }
          recordUsage(userId, tokens);
          persistInteraction(responseText);
          res.write(`data: ${JSON.stringify({ done: true, text: responseText, toolCalls: result.toolCalls.length })}\n\n`);
          return res.end();
        }

        const result = await runWithTools(
          normalizedMessages,
          toolRegistry,
          { provider, model, userId },
          undefined, 3,
          llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
        );

        responseText = result.text || '';
        const tokens = estimateTokens(
          normalizedMessages.map((m: any) => m.content || '').join(' ') + ' ' + responseText
        );
        for (const u of result.usageRecords || []) {
          recordTokenUsage(userId, u.provider, u.model, {
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            totalTokens: u.totalTokens,
          }, `rest_chat_${Date.now()}`, 'chat');
        }
        const usage = recordUsage(userId, tokens);
        persistInteraction(responseText);
        return res.json({ text: responseText, usage, toolCalls: result.toolCalls.length });
      }

      res.json({ text: responseText });
    } catch (error: any) {
      logger.error("AI Proxy Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/ai/chat", optionalAuth, handleChat);
  router.post("/chat", optionalAuth, handleChat);

  router.post("/meeting/analyze", optionalAuth, asyncHandler(async (req, res) => {
    const { provider: reqProvider, notes, startedAt, endedAt, language = "zh", purpose = "meeting", legalCase } = req.body || {};
    const userId = req.user?.uid || 'anonymous';
    const preferred = getUserPreferredLLMConfig(userId, { maxTokens: 1800 });
    const provider = preferred.provider;
    const model = preferred.model;
    if (reqProvider && reqProvider !== provider) {
      logger.warn(`[Meeting] Ignoring request provider ${reqProvider}; using primary brain ${provider}/${model} for user ${userId}`);
    }
    const noteItems = Array.isArray(notes) ? notes : [];
    const transcript = noteItems
      .map((note: any) => {
        const time = note?.time ? new Date(note.time).toLocaleTimeString() : '';
        const text = String(note?.text || '').trim();
        return text ? `[${time}] ${text}` : '';
      })
      .filter(Boolean)
      .join('\n');

    if (!transcript.trim()) {
      return res.status(400).json({ error: 'No meeting transcript to analyze' });
    }

    const access = checkLLMAccess({ userId, provider, model: model || '' });
    if (!access.allowed) {
      return res.status(402).json({ error: access.reason, code: access.tokenLimitReached ? 'TOKEN_LIMIT' : 'PROVIDER_RESTRICTED' });
    }

    const started = startedAt ? new Date(startedAt).toLocaleString() : 'unknown';
    const ended = endedAt ? new Date(endedAt).toLocaleString() : new Date().toLocaleString();
    const outputLanguage = language === 'zh' ? 'Chinese' : 'English';
    const isLegalConsultation = purpose === 'legal_consultation';
    const caseContext = legalCase && typeof legalCase === 'object'
      ? [
          `Case title: ${legalCase.title || ''}`,
          `Case number: ${legalCase.caseNumber || ''}`,
          `Party: ${legalCase.party || ''}`,
          `Cause: ${legalCase.cause || ''}`,
          `Court: ${legalCase.court || ''}`,
          `Judge: ${legalCase.judge || ''}`,
          `Stage: ${legalCase.stage || ''}`,
          `Existing notes: ${legalCase.notes || ''}`,
        ].filter(line => !line.endsWith(': '))
      : [];
    const prompt = isLegalConsultation
      ? [
          `You are Peppa assisting a law firm with a client consultation memo. Output in ${outputLanguage}.`,
          'Do not call tools. Analyze only the case context and transcript below.',
          'Create a practical legal-work memo for lawyer review with these sections:',
          '1. Consultation summary',
          '2. Fact summary',
          '3. Disputed issues / legal questions',
          '4. Missing materials / evidence to request',
          '5. Next steps with owners/deadlines if mentioned',
          '6. Risks and open questions',
          '7. Raw transcript highlights',
          'Add a short safety boundary: this assists lawyers and does not replace licensed legal judgment.',
          '',
          `Started: ${started}`,
          `Ended: ${ended}`,
          '',
          'Case context:',
          ...(caseContext.length > 0 ? caseContext : ['No case context provided.']),
          '',
          'Transcript:',
          transcript,
        ].join('\n')
      : [
          `You are Peppa acting as a meeting analyst. Output in ${outputLanguage}.`,
          'Do not call tools. Analyze only the transcript below.',
          'Create a practical meeting report with these sections:',
          '1. Meeting summary',
          '2. Key decisions',
          '3. Action items with owner if mentioned, otherwise mark owner as unassigned',
          '4. Risks / open questions',
          '5. Follow-up suggestions',
          '6. Raw transcript highlights',
          '',
          `Started: ${started}`,
          `Ended: ${ended}`,
          '',
          'Transcript:',
          transcript,
        ].join('\n');

    const result = await makeLLMCall(
      [{ role: 'user', content: prompt }],
      [],
      { provider, model, maxTokens: 1800, userId },
      llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
    );

    const report = result.text || '';
    const tokens = estimateTokens(prompt + ' ' + report);
    recordTokenUsage(userId, provider, model, result.usage, `meeting_analyze_${Date.now()}`, 'meeting');
    const usage = recordUsage(userId, tokens);
    res.json({ report, usage });
  }));
}
