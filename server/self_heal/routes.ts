// 阶段二·自诊疗模块 — /api/system/health-check 查询与手动触发接口
// GET  /api/system/health-check → 最新报告 / 开放缺陷数 / 待自动修复条目 / 历史修复记录 / 健康评分
// POST /api/system/health-check → 手动触发一轮完整自检（后台执行，立即返回受理状态）
import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { listSelfHealRecords, countOpenDefects, listRepairHistory, getSelfHealDbPath } from "./store";
import { runSelfHeal } from "./engine";
import { getDataPath } from "../config/data_path";

export function mountSelfHealRoutes(router: Router): void {
  // 健康状态查询（只读）
  router.get("/system/health-check", requireAuth, async (_req: Request, res: Response) => {
    try {
      const [records, counts, repairs] = await Promise.all([
        listSelfHealRecords(20),
        countOpenDefects(),
        listRepairHistory(20),
      ]);
      const latest = records[0] || null;
      res.json({
        latestReport: latest,
        openDefects: counts.open,
        pendingAutoRepairs: counts.pendingAuto,
        history: records,
        repairHistory: repairs,
        healthScore: latest?.healthScore ?? 100,
        verdict: latest?.verdict ?? "healthy",
        lastRunAt: latest?.startedAt ?? null,
        dbPath: getSelfHealDbPath(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 手动触发一轮完整自检（含自动修复；异步执行，立即受理）
  router.post("/system/health-check", requireAuth, (req: Request, res: Response) => {
    // 串行保护：同一时刻只允许一轮自检
    if ((global as any).__selfHealRunning) {
      res.status(409).json({ error: "一轮自检已在运行中" });
      return;
    }
    (global as any).__selfHealRunning = true;
    runSelfHeal({ isolated: false })
      .then(report => {
        (global as any).__selfHealRunning = false;
        res.json({
          accepted: true,
          runId: report.runId,
          startedAt: report.startedAt,
          assertionPassed: report.assertionPassed,
          assertionTotal: report.assertionTotal,
          defectsFound: report.defects.length,
          autoRepaired: report.autoRepaired,
          rollbackCount: report.rollbackCount,
          healthScore: report.healthScore,
          verdict: report.verdict,
        });
      })
      .catch((e: Error) => {
        (global as any).__selfHealRunning = false;
        res.status(500).json({ error: e.message });
      });
  });

  // 自检报告详情（按 runId）
  router.get("/system/health-check/reports/:runId", requireAuth, async (req: Request, res: Response) => {
    try {
      const records = await listSelfHealRecords(200);
      const record = records.find((rec: any) => rec.runId === req.params.runId);
      if (!record) {
        res.status(404).json({ error: "未找到该轮自检记录" });
        return;
      }
      res.json({ report: record });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
