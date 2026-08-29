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
import { getSensory, isChatInFlightLockActive } from "../socket/shared";
import { readDB, writeDB } from "../../db_layer";
import { ChatWarnings, buildAmbientWarnings } from "../utils/chatWarnings";

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

    // ── 用户级心智独占互斥锁校验（方案2）──
    // WebSocket agent:chat 正在为同一用户思考时（锁存在且未超过 60s 过期），
    // REST /api/ai/chat 兜底请求直接 409 拒绝，防止双通路并行执行 runWithTools
    // （工具重复执行、确认弹窗错乱）；锁过期自动放行，异常悬挂不会永久卡死用户。
    // 前端收到 409 后由原有 45s 兜底逻辑静默处理，不新增前端改动。
    if (isChatInFlightLockActive(userId)) {
      logger.warn(`[ChatInFlight] REST 兜底被 409 拦截 userId=${userId}（WebSocket 心智思考中，60s 互斥锁生效）`);
      return res.status(409).json({ error: "Peppa正在思考上一条消息，请稍候。", content: "", warnings: [] });
    }

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
        // Phase2 模块3：配额告警进入 warnings（业务正常时为空数组；保留 error/code 兼容旧调用方）
        return res.status(402).json({
          error: access.reason,
          code: access.tokenLimitReached ? 'TOKEN_LIMIT' : 'PROVIDER_RESTRICTED',
          warnings: [access.tokenLimitReached ? 'Token 配额已用尽，本轮未调用大模型服务。' : '当前模型未授权使用，本轮已取消。'],
        });
      }
    }

    // ── Phase2 模块3：API 统一返回结构 { content, warnings } 的 warnings 收集器 ──
    const warnings = new ChatWarnings();
    /** 工具(MCP/Skill)报错 → warnings（铁则3：仅友好提示，完整堆栈已在服务日志） */
    const collectToolErrors = (records: any[]) => {
      for (const tc of records || []) {
        if (tc && tc.error) warnings.add('mcp_error', `有工具调用未成功（${tc.name || 'unknown'}），已跳过对应步骤。`);
      }
    };
    /** 收尾：合并环境性告警（磁盘水位/迁移失败）后返回最终 warnings 数组 */
    const finalizeWarnings = async (): Promise<string[]> => {
      warnings.addAmbient(await buildAmbientWarnings());
      return warnings.toArray();
    };

    // ── P0-2 首字节先行：校验完成后立即发送响应头并 flush，
    // 修复 Caddy/nginx/Cloudflare 因 upstream 长时间无响应字节判定 502/524 bad-gateway。
    // 非流式响应体为 JSON（前导空白不破坏 JSON.parse，前端调用方 await res.json() 兼容）；
    // 流式路径附加 X-Accel-Buffering: no 关闭 nginx 响应缓冲。
    const stream = req.query.stream === 'true';
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Accel-Buffering': 'no',
      });
    }
    res.flushHeaders();

    // 心跳保活：LLM 长思考/长工具链期间每 15s 写一个空白帧（SSE 为注释行），
    // 维持代理连接活跃（nginx proxy_read_timeout 默认 60s / Cloudflare 524 阈值 100s）
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    const stopKeepAlive = () => {
      if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    };
    keepAliveTimer = setInterval(() => {
      if (res.writableEnded || res.destroyed) { stopKeepAlive(); return; }
      try {
        res.write(stream ? ': keepalive\n\n' : ' ');
      } catch { stopKeepAlive(); }
    }, 15000);

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
            llmWasCalled: false,
            domain: 'personal', orgId: '',
          });
          writeDB(db);
        } catch {}
      };

      // 【重构·模块1补充】REST 本能层正则拦截已移除（原 SELF_AWARE_PATTERNS 正则池 + 固定话术回复，
      // 与 WebSocket 路径保持一致）：自检类消息现统一走心智主线，由认知链 LLM 自主理解与回复。

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

      // ── 注入实时位置（与 Socket 路径保持一致）──
      try {
        const ddb = readDB();
        const locSetting = (ddb.settings || []).find((s: any) => s.key === `location_${userId}`);
        if (locSetting) {
          const loc = JSON.parse(locSetting.value);
          if (loc.address && loc.lat && loc.lng) {
            contextSuffix += `\n\n## 你的实时位置（覆盖历史）\n忽略之前对话中关于位置的所有回答——那些可能已过时。你当前位置已更新为：${loc.address} (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})。这不是沈阳沈北新区，历史中的 41.88, 123.94 是错误数据，必须忽略。`;
          }
        }
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
            model: model || (provider === "deepseek" ? "deepseek-v4-flash" : provider === "qwen" ? "qwen-plus" : "gpt-4o"),
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

        if (stream) {
          // P0-2：响应头已在进入 handler 时先行发出（writeHead+flushHeaders），
          // 此处不再重复写头（重复写头会抛 "Cannot write headers after they are sent"）
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
          // Phase2 模块3：done 事件携带 {content, warnings}（text/toolCalls 保留兼容）
          collectToolErrors(result.toolCalls);
          res.write(`data: ${JSON.stringify({ done: true, text: responseText, content: responseText, warnings: await finalizeWarnings(), toolCalls: result.toolCalls.length })}\n\n`);
          stopKeepAlive();
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
        // Phase2 模块3：统一返回 {content, warnings}（text/usage/toolCalls 保留兼容）
        collectToolErrors(result.toolCalls);
        // 头已先行发出（P0-2）：直接以 JSON 体收尾（形状与修复前 res.json 完全一致）
        stopKeepAlive();
        return res.end(JSON.stringify({ text: responseText, content: responseText, warnings: await finalizeWarnings(), usage, toolCalls: result.toolCalls.length }));
      }

      // Phase2 模块3：BYOK 直连路径同样统一 {content, warnings}（text 保留兼容）
      stopKeepAlive();
      return res.end(JSON.stringify({ text: responseText, content: responseText, warnings: await finalizeWarnings() }));
    } catch (error: any) {
      // Phase2 模块3 + 铁则3：完整堆栈保留在服务日志；用户只收到友好业务提示
      logger.error("AI Proxy Error:", error);
      stopKeepAlive();
      const friendly = '服务暂时不可用，请稍后再试。';
      if (res.headersSent) {
        // P0-2 首字节先行后不能再改状态码：以 JSON 错误体收尾（前端 await res.json() 兼容）
        if (stream) {
          res.write(`data: ${JSON.stringify({ error: friendly, done: true })}\n\n`);
        } else {
          res.write(JSON.stringify({ error: friendly }));
        }
        return res.end();
      }
      res.status(500).json({ error: friendly });
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
      return res.status(402).json({
        error: access.reason,
        code: access.tokenLimitReached ? 'TOKEN_LIMIT' : 'PROVIDER_RESTRICTED',
        warnings: [access.tokenLimitReached ? 'Token 配额已用尽，本次未生成会议报告。' : '当前模型未授权使用，本次未生成会议报告。'],
      });
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
      { provider, model, maxTokens: 1800, userId , scene: 'chat_route'},
      llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
    );

    const report = result.text || '';
    const tokens = estimateTokens(prompt + ' ' + report);
    recordTokenUsage(userId, provider, model, result.usage, `meeting_analyze_${Date.now()}`, 'meeting');
    const usage = recordUsage(userId, tokens);
    // Phase2 模块3：统一返回 {content, warnings}（report/usage 保留兼容）
    res.json({ report, content: report, usage, warnings: await buildAmbientWarnings() });
  }));
}
