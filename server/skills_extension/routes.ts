// 阶段三·路由层 — /api/skills/* 前端交互 API
// 覆盖：状态 / 缺口分析 / 检索评估 / 适配（暂存） / 沙箱工坊 / 测试 / 审批三选项 / 密钥管理 / 健康面板 / 自修复 / 审计 / 版本
// 认证：全部 requireAuth（与阶段二一致）。密钥接口永不在响应中返回密文。

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { ensureSkillsReady } from './index';
import { migrateSkillsTables, appendAudit, listAudit, listSkillStoreEntries } from './database';
import { detectGaps } from './gap_detector';
import { searchAndDecide } from './search_engine';
import { adaptCandidate, getStagedTestableTool, listStagedAdaptations, listAdapterVersions } from './adapter';
import { createSandboxProject, iterateTsc, expireOldSandboxProjects } from './sandbox';
import { runTestPipeline, makeSandboxRepair } from './test_pipeline';
import { getIsolatedTestableTool } from './sandbox_isolate/sandbox_host';
import { submitForApproval, decideApproval, listPendingApprovals, expireStaleApprovals, isInToolPool } from './approval';
import { setCredential, removeCredential, listCredentialMeta } from './auth_gateway';
import { buildSkillsHealthBoard, generateSkillsMonthlyBrief, runMonthlyGapReview } from './hooks';
import { autoRemediate } from './monitoring';
import { decideSkillForTask } from './mind_decision';
import { classifyBuiltinToolRisk } from './risk_policy';
import { setSkillStatus } from './lifecycle';
import { isPhase3Enabled, phase3Config } from './switch';
import { getBreakerStatus } from './breakers';
import type { AdapterConfig } from './adapter';

/** 请求会话标识（熔断按会话维度计数） */
function sessionOf(req: Request): string {
  const u = (req as any).user;
  return String(u?.id || u?.username || 'default');
}

export function mountSkillsRoutes(router: Router): void {
  // ── 总开关（PEPPA_PHASE3_SKILL_AUTO_ENABLE）：关闭时仅保留只读状态端点，一键停用整套 Phase3 ──
  if (!isPhase3Enabled()) {
    router.get('/skills/status', requireAuth, (_req: Request, res: Response) => {
      res.json({ ok: true, enabled: false, reason: 'PEPPA_PHASE3_SKILL_AUTO_ENABLE=false，整套阶段三能力已停用' });
    });
    console.error('[SkillsExt] PEPPA_PHASE3_SKILL_AUTO_ENABLE=false → 技能拓展路由未挂载（仅状态端点）');
    return;
  }

  // 惰性初始化（幂等）：迁移阶段三表 + 网关接线 + 例行巡检
  ensureSkillsReady().catch(e => console.error('[SkillsExt] 初始化失败:', e));

  // ── 状态（迁移表 / 模块就绪） ──

  router.get('/skills/status', requireAuth, async (_req: Request, res: Response) => {
    try {
      const mig = await migrateSkillsTables();
      res.json({
        ok: true,
        tables: mig.tables,
        errors: mig.errors,
        staged: listStagedAdaptations(),
        poolCount: 0, // 工具池计数由主系统统计
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── M1 缺口识别 ──

  router.post('/skills/analyze', requireAuth, async (_req: Request, res: Response) => {
    try {
      const result = await detectGaps();
      res.json({ ok: true, gaps: result.gaps, sources: result.sources });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── M2a 检索 + 七维评估 ──

  router.post('/skills/search', requireAuth, async (req: Request, res: Response) => {
    try {
      const keywords: string[] = Array.isArray(req.body?.keywords) ? req.body.keywords.map(String) : [];
      if (keywords.length === 0) return res.status(400).json({ ok: false, error: '缺少 keywords' });
      const result = await searchAndDecide(keywords);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── M2b 自动适配（暂存，批准前不进工具池） ──

  router.post('/skills/adapt', requireAuth, async (req: Request, res: Response) => {
    try {
      const { candidate, config, version } = req.body || {};
      if (!candidate || !config) return res.status(400).json({ ok: false, error: '缺少 candidate/config' });
      const cfg: AdapterConfig = {
        toolName: candidate.name,
        serviceName: config.serviceName,
        origin: candidate.origin || '',
        endpointTemplate: config.endpointTemplate,
        method: config.method || 'GET',
        paramMap: config.paramMap || {},
        extractor: config.extractor,
        complianceDomain: config.complianceDomain || 'none',
        needsCredential: !!config.needsCredential,
        description: config.description || candidate.name,
        securityLevel: config.securityLevel || classifyBuiltinToolRisk("fallback-unknown-tool-desc"),
      };
      if (typeof cfg.extractor !== 'function') return res.status(400).json({ ok: false, error: '缺少 extractor 函数' });
      const r = await adaptCandidate(candidate, cfg, version || '1.0.0', { sessionId: sessionOf(req) });
      res.json({ ok: r.ok, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── M3 沙箱工坊 ──

  router.post('/skills/sandbox', requireAuth, async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      if (!b.gap || !b.endpointTemplate) return res.status(400).json({ ok: false, error: '缺少 gap/endpointTemplate' });
      const project = await createSandboxProject({
        gap: b.gap,
        endpointTemplate: b.endpointTemplate,
        method: b.method || 'GET',
        description: b.description || b.gap.keyword,
        parameters: b.parameters || {},
        paramMap: b.paramMap || {},
        extractorFn: b.extractorFn || 'return JSON.stringify(data);',
        complianceDomain: b.complianceDomain || 'none',
        securityLevel: b.securityLevel || classifyBuiltinToolRisk("fallback-unknown-tool-desc"),
      }, { sessionId: sessionOf(req) });
      // 创建后立即执行 tsc 迭代（≤5 轮）
      const iter = await iterateTsc(project.id);
      res.json({ ok: true, project, tsc: iter });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/sandbox/:id/test', requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      // 方案A：测试对象经 sandbox_host 构建（编译产物 + IPC 代理 handler + 子进程 describe 元信息）
      const tool = await getIsolatedTestableTool(id);
      if (!tool) return res.status(404).json({ ok: false, error: '沙箱工具不可用（编译失败或隔离环境异常）' });
      const report = await runTestPipeline(tool, { projectId: id, repair: makeSandboxRepair(id) });
      if (report.gatePassed) {
        const sub = await submitForApproval(id, tool.name, report);
        res.json({ ok: true, report, approval: sub });
      } else {
        res.json({ ok: false, report, approval: null });
      }
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/sandbox/:id/iterate', requireAuth, async (req: Request, res: Response) => {
    try {
      const r = await iterateTsc(Number(req.params.id));
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── M5 适配器暂存工具测试（自动测试 → 提交审批） ──

  router.post('/skills/staged/:tool/test', requireAuth, async (req: Request, res: Response) => {
    try {
      const tool = getStagedTestableTool(String(req.params.tool));
      if (!tool) return res.status(404).json({ ok: false, error: '无此暂存适配' });
      const report = await runTestPipeline(tool);
      if (report.gatePassed) {
        const sub = await submitForApproval(null, tool.name, report);
        res.json({ ok: true, report, approval: sub });
      } else {
        res.json({ ok: false, report, approval: null });
      }
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 人工审批闸门（三选项） ──

  router.get('/skills/approvals/pending', requireAuth, async (_req: Request, res: Response) => {
    try {
      const pending = await listPendingApprovals();
      res.json({ ok: true, pending });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/approvals/:id/decide', requireAuth, async (req: Request, res: Response) => {
    try {
      const { decision, rejectReason } = req.body || {};
      const by = (req as any).user?.username || 'console';
      const r = await decideApproval(Number(req.params.id), decision, by, rejectReason || '');
      res.json({ ok: r.ok, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── M4 密钥管理（永不含密文） ──

  router.get('/skills/credentials', requireAuth, async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, credentials: await listCredentialMeta() });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/credentials', requireAuth, async (req: Request, res: Response) => {
    try {
      const { serviceName, secret } = req.body || {};
      if (!serviceName || !secret) return res.status(400).json({ ok: false, error: '缺少 serviceName/secret' });
      await setCredential(String(serviceName), String(secret));
      res.json({ ok: true, message: '密钥已加密保存（AES-256-GCM）' });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.delete('/skills/credentials/:service', requireAuth, async (req: Request, res: Response) => {
    try {
      const removed = await removeCredential(String(req.params.service));
      res.json({ ok: removed, message: removed ? '密钥已删除' : '密钥不存在' });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── M6 健康面板 / 月度简报 / 自修复 / 审计 / 版本 ──

  router.get('/skills/health-board', requireAuth, async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, board: await buildSkillsHealthBoard() });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/monthly-brief', requireAuth, async (_req: Request, res: Response) => {
    try {
      const brief = await generateSkillsMonthlyBrief();
      res.json({ ok: true, brief });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/monthly-review', requireAuth, async (_req: Request, res: Response) => {
    try {
      const r = await runMonthlyGapReview();
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/remediate/:tool', requireAuth, async (req: Request, res: Response) => {
    try {
      const r = await autoRemediate(String(req.params.tool));
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/skills/audit', requireAuth, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json({ ok: true, audit: await listAudit(limit) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/skills/versions/:tool', requireAuth, async (req: Request, res: Response) => {
    try {
      res.json({ ok: true, versions: listAdapterVersions(String(req.params.tool)) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 运维：过期清理（手动触发） ──

  router.post('/skills/cleanup', requireAuth, async (_req: Request, res: Response) => {
    try {
      const expired = await expireOldSandboxProjects();
      const stale = await expireStaleApprovals();
      res.json({ ok: true, expiredSandbox: expired, expiredApprovals: stale });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 阶段三·开关/熔断/配置状态（面板可观测） ──

  router.get('/skills/config', requireAuth, async (_req: Request, res: Response) => {
    try {
      const cfg = phase3Config();
      res.json({
        ok: true,
        config: cfg,
        breakers: getBreakerStatus(),
        storeCount: (await listSkillStoreEntries()).length,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 阶段三·技能库（mcp_skill_store：元数据/来源/风险标记/成功率统计） ──

  router.get('/skills/store', requireAuth, async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, store: await listSkillStoreEntries() });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/store/:tool/enable', requireAuth, async (req: Request, res: Response) => {
    try {
      const r = await setSkillStatus(String(req.params.tool), 'enabled', (req as any).user?.username || 'console');
      res.json({ ok: r.ok, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/store/:tool/disable', requireAuth, async (req: Request, res: Response) => {
    try {
      const r = await setSkillStatus(String(req.params.tool), 'disabled', (req as any).user?.username || 'console');
      res.json({ ok: r.ok, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/skills/store/:tool/uninstall', requireAuth, async (req: Request, res: Response) => {
    try {
      const r = await setSkillStatus(String(req.params.tool), 'uninstalled', (req as any).user?.username || 'console');
      res.json({ ok: r.ok, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 阶段三·心智技能决策（innerTick 技能决策维度：需要工具 / 成熟MCP / 复用|修改|自研） ──

  router.post('/skills/decision', requireAuth, async (req: Request, res: Response) => {
    try {
      const task = String(req.body?.task || '');
      const keywords: string[] = Array.isArray(req.body?.keywords) ? req.body.keywords.map(String) : [];
      if (!task || keywords.length === 0) return res.status(400).json({ ok: false, error: '缺少 task/keywords' });
      const decision = await decideSkillForTask(task, keywords, { userId: sessionOf(req), sessionId: sessionOf(req) });
      res.json({ ok: true, decision });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  void isInToolPool; void appendAudit;
}
