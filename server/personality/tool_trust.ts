/**
 * Tool trust learning — tracks per-user tool approval patterns.
 *
 * 本次修复后的信任语义（见任务清单第 1 项）：
 *   - 持久信任：用户批准达阈值后 trusted=true 长期记忆，不再因单次交互取消信任；
 *   - 7 天信任有效期：trusted 工具的 lastSeen 超过 7 天即信任过期（重新走确认弹窗）；
 *   - denies > 0 才强制弹窗确认：有拒绝记录的工具暂时退出信任名单（trusted 记忆保留），
 *     用户再次批准即恢复信任；
 *   - 兼容旧库记录：老方案"阈值命中后清零为 0/0"的记录，加载时迁移为 trusted=true，
 *     不新增表结构（记录 JSON 仅增加可选字段）。
 */
import { readDB, writeDB } from '../../db_layer';

const TRUST_THRESHOLD = 5;                    // consecutive approves before entering trust
const TRUST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 信任有效期：7 天
// 活跃续期落盘节流：lastSeen 内存即时刷新，整库写入最多每小时一次
// （getTrustedTools 每次工具调用都会经过，避免高频 writeDB 拖慢主循环）
const TTL_REFRESH_PERSIST_MS = 60 * 60 * 1000;

interface ToolTrustRecord {
  toolName: string;
  approves: number;   // consecutive approves (reset on denial / after threshold)
  denies: number;     // consecutive denies (reset on approve)
  lastSeen: string;   // ISO timestamp — 信任有效期起点，活跃使用时续期
  /** 新增：曾经批准达信任阈值的持久标记。旧库记录无此字段（加载时按 0/0 规则迁移）。 */
  trusted?: boolean;
}

let cache: Map<string, ToolTrustRecord[]> | null = null;
/** 续期落盘节流表（进程内存，仅控制写频率，不影响正确性） */
const lastPersistMap = new Map<string, Map<string, number>>();

/** 兼容历史记录：老方案达到阈值后清零为 approves=0/denies=0（视为"曾信任"） */
function migrateLegacyRecords(records: ToolTrustRecord[]): void {
  for (const r of records) {
    if (r.trusted === undefined) {
      r.trusted = r.approves === 0 && r.denies === 0;
    }
  }
}

function loadTrust(userId: string): ToolTrustRecord[] {
  if (!cache) cache = new Map();
  if (cache.has(userId)) return cache.get(userId)!;

  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === `tool_trust_${userId}`);
    if (setting) {
      const records = JSON.parse(setting.value) as ToolTrustRecord[];
      migrateLegacyRecords(records);
      cache.set(userId, records);
      return records;
    }
  } catch {}
  const empty: ToolTrustRecord[] = [];
  cache.set(userId, empty);
  return empty;
}

function saveTrust(userId: string, records: ToolTrustRecord[]): void {
  cache?.set(userId, records);
  try {
    const db = readDB();
    if (!db.settings) db.settings = [];
    const idx = db.settings.findIndex((s: any) => s.key === `tool_trust_${userId}`);
    if (idx >= 0) {
      db.settings[idx].value = JSON.stringify(records);
    } else {
      db.settings.push({ key: `tool_trust_${userId}`, value: JSON.stringify(records) });
    }
    writeDB(db);
  } catch {}
}

function findOrCreate(records: ToolTrustRecord[], toolName: string): ToolTrustRecord {
  const existing = records.find(r => r.toolName === toolName);
  if (existing) return existing;
  const record: ToolTrustRecord = { toolName, approves: 0, denies: 0, lastSeen: new Date().toISOString(), trusted: false };
  records.push(record);
  return record;
}

/**
 * Called when a user allows a confirm-level tool.
 * Returns true if the tool is in the trusted state now (freshly promoted,
 * or re-trusted after a denial suspension).
 */
export function recordToolApprove(userId: string, toolName: string): boolean {
  const records = loadTrust(userId);
  const record = findOrCreate(records, toolName);
  record.approves++;
  record.denies = 0;
  record.lastSeen = new Date().toISOString();
  if (record.approves >= TRUST_THRESHOLD) {
    record.approves = 0;
    record.trusted = true; // 达到阈值 → 持久信任（不再清零丢失记忆）
  }
  saveTrust(userId, records);
  return record.trusted === true;
}

/**
 * Called when a user denies a confirm-level tool.
 * Denial does NOT destroy the trust memory (trusted flag persists);
 * it only suspends trust (denies>0 → forced confirmation popup).
 * Returns true on the first denial (suspension just happened).
 */
export function recordToolDeny(userId: string, toolName: string): boolean {
  const records = loadTrust(userId);
  const record = findOrCreate(records, toolName);
  record.denies++;
  record.approves = 0;
  record.lastSeen = new Date().toISOString();
  saveTrust(userId, records);
  return record.denies === 1;
}

/**
 * Get the current trusted tools for this user:
 *   trusted === true（曾经批准达阈值）且 denies === 0（无拒绝记录 → 不强制弹窗）
 *   且 lastSeen 在 7 天有效期内。
 * 命中名单的工具在确认流中自动放行。
 */
export function getTrustedTools(userId: string): string[] {
  const records = loadTrust(userId);
  const now = Date.now();
  const trusted: string[] = [];
  let needPersist = false;

  for (const r of records) {
    if (r.trusted !== true) continue;                 // 从未被批准到信任级
    if ((r.denies || 0) > 0) continue;                // 有拒绝记录 → 强制弹窗确认
    const seen = Date.parse(r.lastSeen || '');
    if (!seen || now - seen > TRUST_TTL_MS) continue; // 超过 7 天 → 信任过期
    trusted.push(r.toolName);
    // 活跃使用续期：内存即时刷新；落盘节流（每小时至多一次整库写）
    r.lastSeen = new Date(now).toISOString();
    const persistedAt = lastPersistMap.get(userId)?.get(r.toolName) || 0;
    if (now - persistedAt > TTL_REFRESH_PERSIST_MS) {
      if (!lastPersistMap.has(userId)) lastPersistMap.set(userId, new Map());
      lastPersistMap.get(userId)!.set(r.toolName, now);
      needPersist = true;
    }
  }

  if (needPersist) saveTrust(userId, records);
  return trusted;
}
