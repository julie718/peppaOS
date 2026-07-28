import { checkGates, recordHeartbeat } from './gates.js';
import { getVitality } from '../life/vitality.js';
import { assessUserState } from '../life/userState.js';

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

export function triggerHeartbeatIfReady(): void {
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
            client.ws.send(JSON.stringify({
              type: 'heartbeat',
              payload: { intent: 'vitality_low', message: msg, score: 0.8, timestamp: new Date().toISOString() },
            }));
            console.log(`[Heartbeat] 低生命体征触发: ${msg}`);
            recordHeartbeat();
            return;
          }
        }
      }
    }

    const result = checkGates();
    if (!result.passed) {
      console.log(`[Heartbeat] 未触发: ${result.reason}`);
      return;
    }

    const sessionId = getActiveSessionId();
    if (!sessionId) {
      console.log('[Heartbeat] 无活跃会话，跳过注入');
      return;
    }

    injectHeartbeatToSession(sessionId, result.intent);
    recordHeartbeat();
    console.log(`[Heartbeat] ✅ 已触发: ${result.intent.message} (${result.intent.score.toFixed(2)})`);
  } catch (err) {
    console.error('[Heartbeat] 触发失败:', err);
  }
}
