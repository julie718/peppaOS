import { checkGates, recordTICKHeartbeat, recordRESTHeartbeat } from './gates.js';
import { getVitality } from '../life/vitality.js';
import { assessUserState } from '../life/userState.js';
import { createProactiveObservation } from '../db/lifeDb.js';

function getActiveSessionId(): string | null {
  return (global as any).__activeSessionId || null;
}

function injectHeartbeatToSession(sessionId: string, intent: any): void {
  const wsClients = (global as any).__wsClients || [];
  for (const client of wsClients) {
    if (client.sessionId === sessionId && client.ws.readyState === 1) {
      client.ws.send(JSON.stringify({
        type: 'heartbeat',
        payload: {
          intent: intent.name,
          message: intent.message,
          score: intent.score,
          timestamp: new Date().toISOString(),
        },
      }));
      console.log(`[Heartbeat] ✅ 已注入到会话 ${sessionId}: ${intent.message}`);
      return;
    }
  }
  console.log(`[Heartbeat] ⚠️ 会话 ${sessionId} 无活跃 WebSocket 连接，跳过注入`);
}

/**
 * 触发心跳检查（如果条件满足则推送消息到活跃会话）
 * @param source 'tick' — TICK 循环调用（每10分钟），使用独立计时器
 *               'rest' — REST/WebSocket 健康数据路径，使用独立计时器
 */
export async function triggerHeartbeatIfReady(source: 'tick' | 'rest' = 'tick'): Promise<void> {
  try {
    // 低生命体征优先触发 — 需同时满足用户状态合适
    const vitality = getVitality();
    const userState = assessUserState();
    if ((vitality.isLowEnergy() || vitality.isLowHealth()) && userState.isSuitableForProactive) {
      const sessionId = getActiveSessionId();
      if (sessionId) {
        const wsClients = (global as any).__wsClients || [];
        for (const client of wsClients) {
          if (client.sessionId === sessionId) {
            const msg = vitality.generateLowEnergyMessage();
            console.log(`[Heartbeat] 低生命体征推送: ${msg} (用户状态: ${JSON.stringify(userState)})`);
            // 创建观察记录
            createProactiveObservation(vitality.getVitality().energy, JSON.stringify(userState), msg).catch(() => {});
            client.ws.send(JSON.stringify({
              type: 'heartbeat',
              payload: { intent: 'vitality_low', message: msg, score: 0.8, timestamp: new Date().toISOString() },
            }));
            console.log(`[Heartbeat] 低生命体征触发: ${msg}`);
            // 低生命体征推送独立于 source，同时记录两个计时器
            recordTICKHeartbeat();
            recordRESTHeartbeat();
            return;
          }
        }
      }
    }

    const result = await checkGates();
    if (!result.passed) {
      console.log(`[Heartbeat] 未触发 [${source}]: ${result.reason}`);
      return;
    }

    const sessionId = getActiveSessionId();
    if (!sessionId) {
      console.log('[Heartbeat] 无活跃会话，跳过注入');
      return;
    }

    injectHeartbeatToSession(sessionId, result.intent);

    // 根据来源使用不同的计时器，互不干扰
    if (source === 'tick') {
      recordTICKHeartbeat();
    } else {
      recordRESTHeartbeat();
    }

    console.log(`[Heartbeat] ✅ 已触发 [${source}]: ${result.intent.message} (${result.intent.score.toFixed(2)})`);
  } catch (err) {
    console.error('[Heartbeat] 触发失败:', err);
  }
}
