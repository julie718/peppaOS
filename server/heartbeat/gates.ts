import { getDesireEngine } from '../desire/engine.js';
import fs from 'fs';

const CONFIG = {
  MIN_INTERVAL_MINUTES: 120,
  DAILY_LIMIT: 10,
  SCORE_THRESHOLD: 0.55,
  SOCIAL_THRESHOLD: 0.65,
  SILENT_START_HOUR: 23,
  SILENT_END_HOUR: 7,
};

interface HeartbeatState {
  lastHeartbeatAt: number;
  todayCount: number;
  todayDate: string;
}

let state: HeartbeatState = {
  lastHeartbeatAt: 0,
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
  const minutesSinceLast = (Date.now() - state.lastHeartbeatAt) / 60000;
  return minutesSinceLast < CONFIG.MIN_INTERVAL_MINUTES;
}

function isDailyLimitReached(): boolean {
  resetDailyIfNeeded();
  return state.todayCount >= CONFIG.DAILY_LIMIT;
}

function checkScoreThreshold(): { passed: boolean; intent: any } {
  const engine = getDesireEngine();
  const intent = engine.getTopIntent();
  const threshold = intent.name === 'social' ? CONFIG.SOCIAL_THRESHOLD : CONFIG.SCORE_THRESHOLD;
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

export function checkGates(): {
  passed: boolean;
  reason: string;
  intent?: any;
} {
  if (isSilentHour()) return { passed: false, reason: '静音窗' };
  if (isThrottled()) return { passed: false, reason: '节流 (间隔 < 120分钟)' };
  if (isDailyLimitReached()) return { passed: false, reason: '日上限已达' };

  const scoreResult = checkScoreThreshold();
  if (!scoreResult.passed) {
    return { passed: false, reason: `分数不足 (${scoreResult.intent.score.toFixed(2)})` };
  }

  if (!isPhysiologicalSafe()) return { passed: false, reason: '生理不安全' };
  if (isUserActive()) return { passed: false, reason: '用户正在活跃' };

  return { passed: true, reason: '通过', intent: scoreResult.intent };
}

export function recordHeartbeat(): void {
  resetDailyIfNeeded();
  state.lastHeartbeatAt = Date.now();
  state.todayCount += 1;
  saveState();
}
