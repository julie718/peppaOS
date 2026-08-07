import { getDesireEngine } from '../desire/engine';
import fs from 'fs';

const CONFIG = {
  MIN_INTERVAL_MINUTES: 60,  // reduced from 120 to allow emotions to evolve more frequently
  DAILY_LIMIT: 10,
  SCORE_THRESHOLD: 0.55,
  SOCIAL_THRESHOLD: 0.65,
  SILENT_START_HOUR: 23,
  SILENT_END_HOUR: 7,
};

// 关系感知的行为调整（懒加载避免循环依赖）
let cachedAdjustment: any = null;
let lastAdjustFetch = 0;
async function getRelationAdjustment(): Promise<any> {
  const now = Date.now();
  if (cachedAdjustment && (now - lastAdjustFetch) < 300000) return cachedAdjustment;
  try {
    const { getBehaviorAdjustment } = await import('../life/relationshipAwareness');
    cachedAdjustment = await getBehaviorAdjustment();
    lastAdjustFetch = now;
    return cachedAdjustment;
  } catch {
    return null;
  }
}

interface HeartbeatState {
  lastTICKHeartbeatAt: number;   // TICK 路径专用计时器（用于节流判断）
  lastRESTHeartbeatAt: number;   // REST/WebSocket 路径专用计时器
  todayCount: number;
  todayDate: string;
}

let state: HeartbeatState = {
  lastTICKHeartbeatAt: 0,
  lastRESTHeartbeatAt: 0,
  todayCount: 0,
  todayDate: '',
};

const STATE_FILE = '/app/data/heartbeat_state.json';

function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) {}
}

function saveState(): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {}
}

loadState();

function resetDailyIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (state.todayDate !== today) {
    state.todayCount = 0;
    state.todayDate = today;
    saveState();
  }
}

function isSilentHour(): boolean {
  const userTimezone = parseInt(process.env.USER_TIMEZONE || '8');
  const now = new Date();
  const userHour = (now.getUTCHours() + userTimezone + 24) % 24;
  return userHour >= CONFIG.SILENT_START_HOUR || userHour < CONFIG.SILENT_END_HOUR;
}

function isThrottled(): boolean {
  const minutesSinceLast = (Date.now() - state.lastTICKHeartbeatAt) / 60000;
  // 基础间隔，关系状态可能缩短
  const baseInterval = CONFIG.MIN_INTERVAL_MINUTES;
  // 异步获取关系调整（同步fallback用基础值）
  let minInterval = baseInterval;
  try {
    // 同步读取缓存（如果getRelationAdjustment已经预加载过）
    if (cachedAdjustment) {
      minInterval = cachedAdjustment.minIntervalMinutes;
    }
  } catch {}
  return minutesSinceLast < minInterval;
}

function isDailyLimitReached(): boolean {
  resetDailyIfNeeded();
  let limit = CONFIG.DAILY_LIMIT;
  try {
    if (cachedAdjustment) {
      limit = cachedAdjustment.dailyLimit;
    }
  } catch {}
  return state.todayCount >= limit;
}

function checkScoreThreshold(): { passed: boolean; intent: any } {
  const engine = getDesireEngine();
  const intent = engine.getTopIntent();
  let socialThreshold = CONFIG.SOCIAL_THRESHOLD;
  let generalThreshold = CONFIG.SCORE_THRESHOLD;
  try {
    if (cachedAdjustment) {
      socialThreshold = cachedAdjustment.socialThreshold;
      generalThreshold = cachedAdjustment.generalThreshold;
    }
  } catch {}
  const threshold = intent.name === 'social' ? socialThreshold : generalThreshold;
  return { passed: intent.score >= threshold, intent };
}

function isPhysiologicalSafe(): boolean {
  try {
    if (fs.existsSync('/app/data/desire_state.json')) {
      const data = JSON.parse(fs.readFileSync('/app/data/desire_state.json', 'utf-8'));
      if (data._physiologicalState === 'busy' || data._physiologicalState === 'sleeping') {
        return false;
      }
    }
  } catch (e) {}
  return true;
}

function isUserActive(): boolean {
  const lastUserMessageAt = (global as any).__lastUserMessageAt || 0;
  return (Date.now() - lastUserMessageAt) < 5 * 60000;
}

export async function checkGates(): Promise<{
  passed: boolean;
  reason: string;
  intent?: any;
  adjustment?: any;
}> {
  // 预加载关系感知调整
  const adj = await getRelationAdjustment();
  if (adj) {
    cachedAdjustment = adj;
  }

  if (isSilentHour()) return { passed: false, reason: '静音窗', adjustment: adj || undefined };
  if (isThrottled()) return { passed: false, reason: `节流 (间隔 < ${adj?.minIntervalMinutes || CONFIG.MIN_INTERVAL_MINUTES}分钟)`, adjustment: adj || undefined };
  if (isDailyLimitReached()) return { passed: false, reason: `日上限已达 (${adj?.dailyLimit || CONFIG.DAILY_LIMIT}条)`, adjustment: adj || undefined };

  const scoreResult = checkScoreThreshold();
  if (!scoreResult.passed) {
    return { passed: false, reason: `分数不足 (${scoreResult.intent.score.toFixed(2)})`, adjustment: adj || undefined };
  }

  if (!isPhysiologicalSafe()) return { passed: false, reason: '生理不安全', adjustment: adj || undefined };
  if (isUserActive()) return { passed: false, reason: '用户正在活跃', adjustment: adj || undefined };

  return { passed: true, reason: '通过', intent: scoreResult.intent, adjustment: adj || undefined };
}

export function recordTICKHeartbeat(): void {
  resetDailyIfNeeded();
  state.lastTICKHeartbeatAt = Date.now();
  state.todayCount += 1;
  saveState();
}

export function recordRESTHeartbeat(): void {
  resetDailyIfNeeded();
  state.lastRESTHeartbeatAt = Date.now();
  // 注意：REST 路径不增加 todayCount，也不影响 TICK 节流判断
  // REST 路径频繁触发（健康数据上报），仅记录时间用于自身追踪
  saveState();
}
