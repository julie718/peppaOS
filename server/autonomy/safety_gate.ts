/**
 * Safety gate for autonomous work — controls when and how Lumi can work independently.
 * Gates: time-of-day, user-idle requirement, token budget, quiet hours.
 */
import { readDB, writeDB } from '../../db_layer';

export interface SafetyGateConfig {
  allowedHours: { start: number; end: number }[];  // e.g. [{start:9, end:18}]
  requireIdle: boolean;
  minIdleSeconds: number;      // default 120 (2 min)
  maxTokensPerHour: number;    // default 2000
  quietHoursEnabled: boolean;
  quietHoursStart: number;     // 0-23
  quietHoursEnd: number;       // 0-23
}

const DEFAULT_CONFIG: SafetyGateConfig = {
  allowedHours: [{ start: 8, end: 22 }],
  requireIdle: true,
  minIdleSeconds: 120,
  maxTokensPerHour: 3000,
  quietHoursEnabled: false,
  quietHoursStart: 22,
  quietHoursEnd: 8,
};

const DB_KEY = 'autonomy_gate_config';

let config: SafetyGateConfig = { ...DEFAULT_CONFIG };
const userTokensThisHour = new Map<string, { hour: number; tokens: number }>();
const userLastIdle = new Map<string, { idleSeconds: number; timestamp: number }>();

export function loadGateConfig(): SafetyGateConfig {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === DB_KEY);
    if (setting?.value) {
      config = { ...DEFAULT_CONFIG, ...JSON.parse(setting.value) };
    }
  } catch {}
  return { ...config };
}

export function getGateConfig(): SafetyGateConfig {
  return { ...config };
}

export function saveGateConfig(partial: Partial<SafetyGateConfig>): SafetyGateConfig {
  config = { ...config, ...partial };
  try {
    const db = readDB();
    let setting = (db.settings || []).find((s: any) => s.key === DB_KEY);
    const value = JSON.stringify(config);
    if (setting) {
      setting.value = value;
    } else {
      if (!db.settings) db.settings = [];
      db.settings.push({ key: DB_KEY, value });
    }
    writeDB(db);
  } catch {}
  return { ...config };
}

/** Called from ambient poller socket handler to record latest idle state */
export function reportIdleState(userId: string, idleSeconds: number) {
  userLastIdle.set(userId, { idleSeconds, timestamp: Date.now() });
}

/** Check if autonomous work is currently allowed for this user */
export function isAutonomousWorkAllowed(userId?: string): { allowed: boolean; reason?: string } {
  const cfg = config;
  const now = new Date();
  const hour = now.getHours();

  // 1. Time-of-day gate
  const inAllowedHours = cfg.allowedHours.some(
    range => hour >= range.start && hour < range.end,
  );
  if (!inAllowedHours) {
    return { allowed: false, reason: `Current hour (${hour}) is outside allowed ranges` };
  }

  // 2. Quiet hours — suppress proactive notifications, not work itself
  // (quiet hours don't block work, they just suppress notifications — handled elsewhere)

  // 3. Idle gate
  if (cfg.requireIdle && userId) {
    const idle = userLastIdle.get(userId);
    if (!idle || Date.now() - idle.timestamp > 60000) {
      return { allowed: false, reason: 'No recent idle data from client' };
    }
    if (idle.idleSeconds < cfg.minIdleSeconds) {
      return { allowed: false, reason: `User active (idle ${idle.idleSeconds}s < ${cfg.minIdleSeconds}s required)` };
    }
  }

  // 4. Token budget
  if (userId) {
    const entry = userTokensThisHour.get(userId);
    if (entry && entry.hour === hour && entry.tokens >= cfg.maxTokensPerHour) {
      return { allowed: false, reason: `Token budget exhausted (${entry.tokens}/${cfg.maxTokensPerHour})` };
    }
  }

  return { allowed: true };
}

/** Record token usage for budget tracking */
export function recordAutonomousTokens(userId: string, tokens: number) {
  const hour = new Date().getHours();
  const entry = userTokensThisHour.get(userId);
  if (!entry || entry.hour !== hour) {
    userTokensThisHour.set(userId, { hour, tokens });
  } else {
    entry.tokens += tokens;
  }
}

// Load config on import
loadGateConfig();
