// Messaging integrations (Feishu, etc.)
import { Router } from "express";
import { createMessagingRoutes } from "../messaging";
import { getMessagingConfig } from "../messaging/config";
import { personalityRegistry } from "../personality";
import { queryMemories } from "../memory";
import { loadEmotionalState } from "../personality/state";

export function setupMessaging(
  apiRouter: Router,
  llm: { getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any },
) {
  const cfg = getMessagingConfig();

  if (cfg.feishu?.appId && cfg.feishu?.appSecret) {
    apiRouter.use("/", createMessagingRoutes(cfg.feishu, {
      llmGetters: { getDeepSeek: llm.getDeepSeek, getGemini: llm.getGemini, getOpenAI: llm.getOpenAI, getAnthropic: llm.getAnthropic, getQwen: llm.getQwen },
      personalityRegistry,
      queryMemories,
      loadEmotionalState,
    }));
    console.log('[Feishu] Messaging routes mounted at /api/feishu/*');
  } else {
    console.log('[Feishu] Not configured — set FEISHU_APP_ID and FEISHU_APP_SECRET in .env');
  }
}
