/**
 * Safety gate for autonomous work — controls when and how Lumi can work independently.
 * Gates: time-of-day, user-idle requirement, token budget, quiet hours.
 */
import { readDB, writeDB } from '../../db_layer';

export interface SafetyGateConfig {
  alwaysOnline: boolean;
  autoProcessEnabled: boolean;
  externalAppAutomationEnabled: boolean;
  messagingSendRequiresConfirmation: boolean;
  maxConsecutiveTasks: number;
  allowedHours: { start: number; end: number }[];  // e.g. [{start:9, end:18}]
  requireIdle: boolean;
  minIdleSeconds: number;      // default 120 (2 min)
  maxTokensPerHour: number;    // default 2000
  quietHoursEnabled: boolean;
  quietHoursStart: number;     // 0-23
  quietHoursEnd: number;       // 0-23
}

const DEFAULT_CONFIG: SafetyGateConfig = {
  alwaysOnline: true,
  autoProcessEnabled: false,
  externalAppAutomationEnabled: false,
  messagingSendRequiresConfirmation: true,
  maxConsecutiveTasks: 1,
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
      config = normalizeGateConfig({ ...DEFAULT_CONFIG, ...JSON.parse(setting.value) });
    }
  } catch {}
  return { ...config };
}

export function getGateConfig(): SafetyGateConfig {
  return { ...config };
}

export function saveGateConfig(partial: Partial<SafetyGateConfig>): SafetyGateConfig {
  config = normalizeGateConfig({ ...config, ...partial });
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

function normalizeGateConfig(input: Partial<SafetyGateConfig>): SafetyGateConfig {
  const next = { ...DEFAULT_CONFIG, ...input };
  next.allowedHours = Array.isArray(next.allowedHours) && next.allowedHours.length > 0
    ? next.allowedHours
        .map(range => ({
          start: Math.max(0, Math.min(23, Number(range?.start) || 0)),
          end: Math.max(0, Math.min(24, Number(range?.end) || 24)),
        }))
        .filter(range => range.end > range.start)
    : DEFAULT_CONFIG.allowedHours;
  next.minIdleSeconds = Math.max(0, Math.min(3600, Number(next.minIdleSeconds) || DEFAULT_CONFIG.minIdleSeconds));
  next.maxTokensPerHour = Math.max(100, Math.min(100000, Number(next.maxTokensPerHour) || DEFAULT_CONFIG.maxTokensPerHour));
  next.maxConsecutiveTasks = Math.max(1, Math.min(10, Number(next.maxConsecutiveTasks) || DEFAULT_CONFIG.maxConsecutiveTasks));
  next.alwaysOnline = Boolean(next.alwaysOnline);
  next.autoProcessEnabled = Boolean(next.autoProcessEnabled);
  next.externalAppAutomationEnabled = Boolean(next.externalAppAutomationEnabled);
  next.messagingSendRequiresConfirmation = next.messagingSendRequiresConfirmation !== false;
  next.requireIdle = Boolean(next.requireIdle);
  next.quietHoursEnabled = Boolean(next.quietHoursEnabled);
  next.quietHoursStart = Math.max(0, Math.min(23, Number(next.quietHoursStart) || DEFAULT_CONFIG.quietHoursStart));
  next.quietHoursEnd = Math.max(0, Math.min(23, Number(next.quietHoursEnd) || DEFAULT_CONFIG.quietHoursEnd));
  return next;
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

  if (!cfg.alwaysOnline) {
    return { allowed: false, reason: 'Always Online is disabled' };
  }

  if (!cfg.autoProcessEnabled) {
    return { allowed: false, reason: 'Automatic processing is disabled until the user confirms a workflow' };
  }

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

export function isExternalAppAutomationAllowed(): boolean {
  return Boolean(config.externalAppAutomationEnabled);
}

export function isMessagingSendConfirmationRequired(): boolean {
  return config.messagingSendRequiresConfirmation !== false;
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
