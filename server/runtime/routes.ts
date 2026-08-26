// Route aggregator — mounts all shared routes on the API router
import { Router } from "express";
import { Server } from "socket.io";
import { mountDebugRoutes } from "../routes/debug_routes";
import { mountPersonalityRoutes } from "../routes/personality_routes";
import { mountMcpRoutes } from "../routes/mcp_routes";
import { mountDeviceRoutes } from "../routes/device_routes";
import { mountSystemRoutes } from "../routes/system_routes";
import { mountSelfHealRoutes } from "../self_heal/routes";
import { mountPhase3Routes } from "../phase3/routes";
import { mountSkillsRoutes } from "../skills_extension/routes";
import { mountChatRoutes } from "../routes/chat_routes";
import { mountPreferencesRoutes } from "../routes/preferences_routes";
import { mountInteractionsRoutes } from "../routes/interactions_routes";
import { mountAuthRoutes } from "../routes/auth";
import { mountMemoryRoutes } from "../routes/memory_routes";
import { mountConversationRoutes } from "../routes/conversations";
import { mountAgentRoutes } from "../routes/agent_routes";
import { mountSkillRoutes } from "../routes/skill_routes";
import { mountMarketplaceRoutes } from "../routes/marketplace_routes";
import { mountMiscRoutes } from "../routes/misc_routes";
import { mountContactsRoutes } from "../routes/contacts_routes";
import { mountBranchConnectionRoutes } from "../routes/branch_routes";
import { mountNotificationRoutes } from "../routes/notifications";
import { autonomyRoutes } from "../routes/autonomy_routes";
import { mountExploreRoutes, mountPlanRoutes } from "../routes/plan_explore_routes";
import { mountMusicRoutes } from "../routes/music_routes";

interface RouteContext {
  apiRouter: Router;
  jwtSecret: string;
  llm: {
    getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any; getArk: any; getGlm: any;
  };
  getCookieOptions: () => { httpOnly: true; secure: boolean; sameSite: "none" | "lax"; maxAge: number };
  io: Server;
}

export function mountAllRoutes({ apiRouter, jwtSecret, llm, getCookieOptions, io }: RouteContext) {
  const llmGetters = { getDeepSeek: llm.getDeepSeek, getGemini: llm.getGemini, getOpenAI: llm.getOpenAI, getAnthropic: llm.getAnthropic, getQwen: llm.getQwen, getArk: llm.getArk, getGlm: llm.getGlm };

  // Personality, MCP, Device management
  mountPersonalityRoutes(apiRouter, jwtSecret, llmGetters);
  mountMcpRoutes(apiRouter);
  mountDeviceRoutes(apiRouter, jwtSecret);

  // Phase2 模块8：调试后台 API（requireAuth + requireAdmin，仅只读观测）
  mountDebugRoutes(apiRouter);

  // Phase-3 八模块（欲望/自省/联想/人格演化/情绪/技能总览/Watch感知/机器人）统一挂载
  mountPhase3Routes(apiRouter, io);

  // System routes (health, tools, llm, settings, stats, ecosystem, modules)
  mountSystemRoutes(apiRouter, jwtSecret, io);

  // [阶段二·自诊疗] 健康自检查询/手动触发（GET/POST /api/system/health-check）
  mountSelfHealRoutes(apiRouter);
  // 阶段三·技能拓展（独立目录模块，仅新增挂载点）
  mountSkillsRoutes(apiRouter);

  // AI Chat
  mountChatRoutes(apiRouter, jwtSecret, llmGetters);

  // Auth
  mountAuthRoutes(apiRouter, jwtSecret, getCookieOptions);

  // Agents
  mountAgentRoutes(apiRouter, jwtSecret, llmGetters);

  // Preferences & Interactions
  mountPreferencesRoutes(apiRouter, jwtSecret);
  mountInteractionsRoutes(apiRouter, jwtSecret);

  // Memory & Conversation
  mountMemoryRoutes(apiRouter, jwtSecret, llmGetters);
  mountConversationRoutes(apiRouter, jwtSecret);

  // Skills & Marketplace
  mountSkillRoutes(apiRouter, jwtSecret, llmGetters, io);
  mountMarketplaceRoutes(apiRouter, jwtSecret, io, llmGetters);

  // Contacts
  mountContactsRoutes(apiRouter, jwtSecret);

  // Branch connection (employee→company)
  mountBranchConnectionRoutes(apiRouter, jwtSecret);

  // Notifications
  mountNotificationRoutes(apiRouter);

  // System Exploration & Plans
  mountExploreRoutes(apiRouter);
  mountPlanRoutes(apiRouter);

  // Music profile and library analysis
  mountMusicRoutes(apiRouter);

  // Autonomy
  apiRouter.use('/autonomy', autonomyRoutes());

  // Misc (founder vision, feedback, admin config, Org chat)
  mountMiscRoutes(apiRouter, jwtSecret, llmGetters);
}
