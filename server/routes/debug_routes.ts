// server/routes/debug_routes.ts
// Phase2 模块8：调试后台 API — 只读观测心智/感知队列/休眠记忆
// 鉴权：requireAuth + requireAdmin（仅 admin 角色可访问）
// 铁则1：本组接口只读，绝不提供删除/清空业务数据的端点（休眠记忆永不物理删除，仅查询）。

import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { logger } from '../lib/logger';

export function mountDebugRoutes(router: Router): void {
  const debug = Router();
  debug.use(requireAuth, requireAdmin);

  /** 心智记录：最近 InnerTick 快照（含 isPublic 内部推理，仅后台可见，不流入聊天） */
  debug.get('/mind', async (_req, res) => {
    try {
      const { getRecentInnerTickSnapshots } = await import('../db/lifeDb');
      const rows = await getRecentInnerTickSnapshots(20);
      const parsed = rows.map(r => {
        try {
          return { ...r, inner_output: JSON.parse(r.inner_output) };
        } catch {
          return r;
        }
      });
      res.json({ count: parsed.length, snapshots: parsed });
    } catch (err: any) {
      logger.error('[Debug] /mind 读取失败:', err);
      res.status(500).json({ error: '读取心智记录失败' });
    }
  });

  /** 感知事件队列状态：内存队列 + SQLite 后备（pending/drained）统计 */
  debug.get('/perception-queue', async (_req, res) => {
    try {
      const { getPerceptionQueueStatus } = await import('../perception/queue');
      const status = await getPerceptionQueueStatus();
      res.json(status);
    } catch (err: any) {
      logger.error('[Debug] /perception-queue 读取失败:', err);
      res.status(500).json({ error: '读取感知队列状态失败' });
    }
  });

  /** 休眠记忆：权重衰减至阈值下的记忆（铁则1：记录永不删除，仅后台可查全量） */
  debug.get('/memories/hibernated', async (req, res) => {
    try {
      const { getHibernatedMemories, countHibernatedMemories } = await import('../memory/store');
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
      const memories = await getHibernatedMemories(userId);
      const count = await countHibernatedMemories(userId);
      res.json({ count, limit, memories: memories.slice(0, limit) });
    } catch (err: any) {
      logger.error('[Debug] /memories/hibernated 读取失败:', err);
      res.status(500).json({ error: '读取休眠记忆失败' });
    }
  });

  /** 最近外部搜索记录（模块5 摘要化落库，供审计查询） */
  debug.get('/search-records', async (req, res) => {
    try {
      const { getRecentSearchRecords } = await import('../db/lifeDb');
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
      const rows = await getRecentSearchRecords(userId, limit);
      res.json({ count: rows.length, records: rows });
    } catch (err: any) {
      logger.error('[Debug] /search-records 读取失败:', err);
      res.status(500).json({ error: '读取搜索记录失败' });
    }
  });

  // 挂载到 /debug 前缀（此前子 router 未附加到父 router —— 修复：router.use('/debug', debug)）
  router.use('/debug', debug);
}
