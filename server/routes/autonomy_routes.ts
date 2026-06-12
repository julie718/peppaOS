import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getGateConfig, saveGateConfig } from '../autonomy/safety_gate';
import { getTaskQueue, cancelTask, getTaskHistory } from '../autonomy/task_queue';

export function autonomyRoutes(): Router {
  const router = Router();

  // Safety gate config
  router.get('/gate_config', requireAuth, (_req, res) => {
    res.json(getGateConfig());
  });

  router.put('/gate_config', requireAuth, (req, res) => {
    const updated = saveGateConfig(req.body || {});
    res.json(updated);
  });

  // Task queue
  router.get('/queue', requireAuth, (_req, res) => {
    res.json({ queue: getTaskQueue() });
  });

  router.get('/history', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    res.json({ tasks: getTaskHistory(limit, offset) });
  });

  router.post('/tasks/:id/cancel', requireAuth, (req, res) => {
    const ok = cancelTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found or not cancellable' });
    res.json({ id: req.params.id, cancelled: true });
  });

  return router;
}
