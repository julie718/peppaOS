import { getDesireEngine } from '../desire/engine.js';

export async function handleHealthData(req: any, res: any) {
  try {
    const { heartRate, hrv, steps } = req.body;
    const engine = getDesireEngine();

    if (heartRate !== null && typeof heartRate === 'number') {
      if (heartRate > 100) {
        engine.ingest({ fatigue: 0.05, stress: 0.03 });
      } else if (heartRate < 60) {
        engine.ingest({ stress: -0.02 });
      }
    }

    if (hrv !== null && typeof hrv === 'number' && hrv < 30) {
      engine.ingest({ stress: 0.08, attachment: 0.05 });
    }

    if (steps !== null && typeof steps === 'number' && steps > 5000) {
      engine.ingest({ fatigue: 0.02, curiosity: 0.03 });
    }

    engine.tick();

    const intent = engine.getTopIntent();
    if (intent.score >= 0.55) {
      console.log(`[Heartbeat] REST触发心跳: ${intent.message} (${intent.score.toFixed(2)})`);
    }

    res.json({ status: 'ok', intent });
  } catch (err) {
    console.error('[Health API] 处理失败:', err);
    res.status(500).json({ status: 'error', message: String(err) });
  }
}
