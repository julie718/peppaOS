#!/usr/bin/env npx tsx
// scripts/cleanup_phase3_ghost_memories.ts
// Phase-2 综合修复（item 12）：清理 Phase-3 验收测试遗留的「幽灵数据」。
//
// 清理对象（严格限定测试标记，绝不触碰正常数据）：
//   life.db  P3 表：desire_records / desire_record_events / self_reflection_records /
//                   personality_drift_records / emotion_system_state / emotion_system_events /
//                   watch_perception_events / robot_devices / robot_command_log /
//                   memory_associations / inner_tick_snapshot
//   peppa.db 业务表：memories / interactions
//
// 匹配规则：
//   1) 用户归属列（user_id / user_uid / owner_uid）精确等于 'tester' —— 主匹配；
//   2) 机器人表：robot_devices.id LIKE 'testbot-%'（测试验收机器人）及关联指令日志；
//   3) 内容列（content / message）：仅匹配强标记 '%ghost%' / '%幽灵%' / '[P3%'
//      （不用裸 'test'/'测试'，避免误伤用户真实记忆，如「今天做了测试」）；
//   4) 来源/上下文列（source / context / detail / payload_json）匹配 '%test%' / '%ghost%' / '%幽灵%'。
//   子表（desire_record_events / robot_command_log）按父表级联删除，FK 安全。
//
// 用法：
//   npx tsx scripts/cleanup_phase3_ghost_memories.ts            # 预览（默认 dry-run，只统计不删除）
//   npx tsx scripts/cleanup_phase3_ghost_memories.ts --commit   # 确认后执行删除
//   npx tsx scripts/cleanup_phase3_ghost_memories.ts --days 30  # 事件表附加「N 天前」过滤（可与 --commit 组合）
//
// 安全护栏：
//   - 默认 dry-run：只输出每表统计与匹配行预览，不写库；
//   - 表不存在（P3 未启用过的旧库）自动跳过；
//   - 每表删除后回读计数核对；SQLite 外键约束关闭时子表先删。

import sqlite3 from 'sqlite3';
import fs from 'fs';
import { getDataPath } from '../server/config/data_path';

const ARGS = new Set(process.argv.slice(2));
const COMMIT = ARGS.has('--commit');
const DAYS = (() => {
  const idx = process.argv.indexOf('--days');
  const n = Number(process.argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
})();

const LIFE_DB_PATH = process.env.LIFE_DB_PATH || getDataPath('life.db');
const PEPPA_DB_PATH = process.env.DB_PATH || getDataPath('peppa.db');

// ── 轻量 Promise 封装（sqlite3 回调 → async/await）──
function openDb(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (err) => (err ? reject(err) : resolve(db)));
  });
}
function all<T>(db: sqlite3.Database, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[]))));
}
function run(db: sqlite3.Database, sql: string, params: any[] = []): Promise<{ changes: number }> {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (this: sqlite3.RunResult, err) {
      if (err) reject(err);
      else resolve({ changes: this.changes });
    }),
  );
}

/** 表是否存在 */
async function tableExists(db: sqlite3.Database, name: string): Promise<boolean> {
  const rows = await all<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name]);
  return rows.length > 0;
}

interface CleanTarget {
  db: 'life' | 'peppa';
  table: string;
  /** 该表删除计数用的整表匹配 WHERE（不带 'DELETE FROM ...' 前缀） */
  where: string;
  params: any[];
  /** 描述（日志用） */
  desc: string;
  /** 时间列（--days 过滤用；默认 created_at，个别表为 received_at/registered_at） */
  timeCol?: string;
}

const MARKER_STRONG = ['%ghost%', '%幽灵%', '[P3%'];
const MARKER_WEAK = ['%test%', '%ghost%', '%幽灵%'];

async function main(): Promise<void> {
  console.log(`[CleanupP3] 幽灵数据清理（${COMMIT ? '--commit 执行模式' : 'dry-run 预览模式'}）`);
  console.log(`[CleanupP3] life.db  = ${LIFE_DB_PATH}`);
  console.log(`[CleanupP3] peppa.db = ${PEPPA_DB_PATH}`);
  if (DAYS > 0) console.log(`[CleanupP3] 事件表附加过滤：仅清理 ${DAYS} 天前的数据`);
  if (!fs.existsSync(LIFE_DB_PATH)) {
    console.warn(`[CleanupP3] life.db 不存在（${LIFE_DB_PATH}），跳过 life.db 部分`);
  }
  if (!fs.existsSync(PEPPA_DB_PATH)) {
    console.warn(`[CleanupP3] peppa.db 不存在（${PEPPA_DB_PATH}），跳过 peppa.db 部分`);
  }

  const ageClause = (col: string) => (DAYS > 0 ? ` AND ${col} < datetime('now', ?)` : '');
  const ageParam = DAYS > 0 ? [`-${DAYS} days`] : [];

  const targets: CleanTarget[] = [];

  // ── life.db P3 表（先子表后父表，FK 安全）──
  targets.push({
    db: 'life', table: 'desire_record_events', desc: '欲望记录事件（级联子表）',
    where: 'desire_id IN (SELECT id FROM desire_records WHERE user_id = ?)' + ageClause('created_at'),
    params: ['tester', ...ageParam],
  });
  targets.push({
    db: 'life', table: 'desire_records', desc: '欲望记录',
    where: 'user_id = ?' + ageClause('created_at'),
    params: ['tester', ...ageParam],
  });
  targets.push({
    db: 'life', table: 'self_reflection_records', desc: '自省记录',
    where: `(user_id = ? OR content LIKE ? OR content LIKE ? OR content LIKE ?)` + ageClause('created_at'),
    params: ['tester', ...MARKER_STRONG, ...ageParam],
  });
  targets.push({
    db: 'life', table: 'personality_drift_records', desc: '人格漂移记录',
    where: 'user_id = ?' + ageClause('created_at'),
    params: ['tester', ...ageParam],
  });
  targets.push({
    db: 'life', table: 'emotion_system_state', desc: '情绪系统状态',
    where: `(user_id = ? OR context_json LIKE ? OR source LIKE ? OR source LIKE ?)` + ageClause('created_at'),
    params: ['tester', ...MARKER_WEAK, ...ageParam],
  });
  targets.push({
    db: 'life', table: 'emotion_system_events', desc: '情绪系统事件',
    where: `(user_id = ? OR context LIKE ? OR context LIKE ? OR context LIKE ?)` + ageClause('created_at'),
    params: ['tester', ...MARKER_STRONG, ...ageParam],
  });
  targets.push({
    db: 'life', table: 'watch_perception_events', desc: '感知事件',
    where: `(user_id = ? OR source LIKE ? OR source LIKE ? OR payload_json LIKE ?)` + ageClause('received_at'),
    timeCol: 'received_at',
    params: ['tester', ...MARKER_WEAK, ...ageParam],
  });
  targets.push({
    db: 'life', table: 'robot_command_log', desc: '机器人指令日志（级联子表）',
    where: '(robot_id LIKE ? OR robot_id NOT IN (SELECT id FROM robot_devices WHERE id NOT LIKE ?))' + ageClause('created_at'),
    params: ['testbot-%', 'testbot-%', ...ageParam],
  });
  targets.push({
    db: 'life', table: 'robot_devices', desc: '机器人设备',
    where: '(id LIKE ? OR owner_uid = ?)' + ageClause('registered_at'),
    timeCol: 'registered_at',
    params: ['testbot-%', 'tester', ...ageParam],
  });
  targets.push({
    db: 'life', table: 'memory_associations', desc: '记忆联想边',
    where: 'user_id = ?' + ageClause('created_at'),
    params: ['tester', ...ageParam],
  });
  targets.push({
    db: 'life', table: 'inner_tick_snapshot', desc: 'InnerTick 快照',
    where: 'user_uid = ?' + ageClause('created_at'),
    params: ['tester', ...ageParam],
  });

  // ── peppa.db 业务表（业务记忆铁则：仅清理明确测试标记行）──
  targets.push({
    db: 'peppa', table: 'memories', desc: '记忆',
    where: `(userId = ? OR content LIKE ? OR content LIKE ? OR content LIKE ?)`,
    params: ['tester', ...MARKER_STRONG],
  });
  targets.push({
    db: 'peppa', table: 'interactions', desc: '对话记录',
    where: `(userId = ? OR message LIKE ? OR message LIKE ?)`,
    params: ['tester', '%ghost%', '%幽灵%'],
  });

  // ── 汇总预览 ──
  console.log('\n[CleanupP3] ── 匹配预览 ──');
  const lifeDb = fs.existsSync(LIFE_DB_PATH) ? await openDb(LIFE_DB_PATH) : null;
  const peppaDb = fs.existsSync(PEPPA_DB_PATH) ? await openDb(PEPPA_DB_PATH) : null;

  let grandTotal = 0;
  for (const t of targets) {
    const db = t.db === 'life' ? lifeDb : peppaDb;
    if (!db) continue;
    if (!(await tableExists(db, t.table))) {
      console.log(`  [跳过] ${t.db}/${t.table} — 表不存在（该模块未启用/未建表）`);
      continue;
    }
    const rows = await all<Record<string, unknown>>(db, `SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.where}`, t.params);
    const n = Number(rows[0]?.n ?? 0);
    grandTotal += n;
    console.log(`  ${n > 0 ? '⚠' : ' '} ${t.db}/${t.table} (${t.desc}): ${n} 行`);
  }

  console.log(`\n[CleanupP3] 匹配总数: ${grandTotal} 行`);
  if (grandTotal === 0) {
    console.log('[CleanupP3] 无可清理数据，退出。');
    await lifeDb?.close(); await peppaDb?.close();
    return;
  }

  if (!COMMIT) {
    console.log('\n[CleanupP3] dry-run 模式：仅预览不删除。确认无误后执行:');
    console.log('  npx tsx scripts/cleanup_phase3_ghost_memories.ts --commit');
    if (DAYS > 0) console.log('  （与 --days N 组合：npx tsx scripts/cleanup_phase3_ghost_memories.ts --commit --days 30）');
    await lifeDb?.close(); await peppaDb?.close();
    return;
  }

  // ── 执行删除（子表在前已排好序；逐表回读核对）──
  console.log('\n[CleanupP3] ── 执行删除 ──');
  let deletedTotal = 0;
  for (const t of targets) {
    const db = t.db === 'life' ? lifeDb : peppaDb;
    if (!db) continue;
    if (!(await tableExists(db, t.table))) continue;
    const before = await all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.where}`, t.params);
    const n = Number(before[0]?.n ?? 0);
    if (n === 0) continue;
    const res = await run(db, `DELETE FROM ${t.table} WHERE ${t.where}`, t.params);
    const after = await all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.where}`, t.params);
    const remain = Number(after[0]?.n ?? 0);
    deletedTotal += res.changes;
    if (res.changes !== n || remain !== 0) {
      console.warn(`  [警告] ${t.db}/${t.table}: 预期删 ${n} 实际删 ${res.changes}，剩余 ${remain}（请人工复核）`);
    } else {
      console.log(`  ✓ ${t.db}/${t.table}: 删除 ${res.changes} 行`);
    }
  }

  console.log(`\n[CleanupP3] 完成：共删除 ${deletedTotal} 行幽灵数据。`);
  console.log('[CleanupP3] 提示：删除的是测试残留（tester / testbot-* / ghost / 幽灵 / [P3 标记），正常业务数据不受影响。');
  await lifeDb?.close(); await peppaDb?.close();
}

main().catch((err) => {
  console.error('[CleanupP3] 执行失败:', err);
  process.exit(1);
});
