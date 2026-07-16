// Messaging integrations (Feishu, WeCom, etc.)
import { Router } from "express";
import { logger } from '../lib/logger';
import { createMessagingRoutes, createWeComRoutes } from "../messaging";
import { createWeChatRoutes } from "../messaging/wechat-routes";
import { getMessagingConfig } from "../messaging/config";
import { personalityRegistry } from "../personality";
import { queryMemories } from "../memory";
import { loadEmotionalState } from "../personality/state";

export function setupMessaging(
  apiRouter: Router,
  llm: { getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any; getArk: any },
) {
  const cfg = getMessagingConfig();
  const llmGetters = { getDeepSeek: llm.getDeepSeek, getGemini: llm.getGemini, getOpenAI: llm.getOpenAI, getAnthropic: llm.getAnthropic, getQwen: llm.getQwen, getArk: llm.getArk };

  // Always mount messaging routes so UI can save config even before env vars are set
  // Feishu
  apiRouter.use("/", createMessagingRoutes(cfg.feishu, {
    llmGetters,
    personalityRegistry,
    queryMemories,
    loadEmotionalState,
  }));
  logger.info(cfg.feishu?.appId && cfg.feishu?.appSecret ? '[Feishu] Active' : '[Feishu] Mounted (not configured)');

  // WeCom
  apiRouter.use("/", createWeComRoutes(cfg.wecom, {
    llmGetters,
    personalityRegistry,
    queryMemories,
    loadEmotionalState,
  }));
  logger.info(cfg.wecom?.corpId && cfg.wecom?.appSecret ? '[WeCom] Active' : '[WeCom] Mounted (not configured)');

  // WeChat ClawBot — always mounted so UI can manage QR login + config
  apiRouter.use("/", createWeChatRoutes(cfg.wechat, {
    llmGetters,
    personalityRegistry,
    queryMemories,
    loadEmotionalState,
  }));
  logger.info(cfg.wechat?.botToken && cfg.wechat?.botId ? '[WeChat] Active' : '[WeChat] Mounted (not configured)');
}
