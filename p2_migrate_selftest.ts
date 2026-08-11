// p2_migrate_selftest.ts — P2迁移自测脚本（自包含，无外部依赖）
// 覆盖：
//   ① 开关关闭（默认 false）：旧 TICK 路径写 emotions/desires/personality/relationship_state 正常落库（维持原有行为）；
//   ② 开关开启：非 InnerTick 路径写入被 paradigmGuard 拦截（返回 -1 / 跳过 SQL），触发 [P2-MIGRATE] 告警，数据不变；
//   ③ 开关开启：InnerTick 路径（runInnerTick 统一落库入口 applyMentalDriftToBusinessState）经守卫校验后正常落库；
//   ④ 开关关闭回滚：拦截解除，旧路径恢复写库（一键回滚验证）。
// 运行：npx tsx p2_migrate_selftest.ts   （使用独立临时 SQLite 库，绝不污染生产 life.db）
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
// type-only 导入：编译期删除、不执行模块，保证 env（LIFE_DB_PATH）先于运行时模块加载生效
import type { InnerTickOutput } from './src/types/innerTickSchema';

// ── 0. 独立临时库：必须在任何 lifeDb 模块加载前设置 ──
const TMP_DB = path.join(os.tmpdir(), `p2_migrate_selftest_${process.pid}.db`);
process.env.LIFE_DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passCount++; console.log(`  ✅ PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failCount++; console.log(`  ❌ FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  console.log('══════════════════════════════════════════════════════════');
  console.log('[P2-MIGRATE] 自测开始 | 临时库:', TMP_DB);
  console.log('══════════════════════════════════════════════════════════');

  // 动态加载（env 已就位后才触碰模块）
  const lifeDb = await import('./server/db/lifeDb');
  const { MIND_SWITCH } = await import('./src/config/mindSwitch');
  const { applyMentalDriftToBusinessState } = await import('./src/core/innerTick');

  // 显式执行建表迁移（自测脚本直接查库，绕过 lifeDb 内部 run/get 的迁移 gate）
  await lifeDb.migrateLifeTables();

  // 捕获告警输出（守卫告警走 console.error / console.warn）
  const captured: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); origError(...args); };
  console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); origWarn(...args); };

  const q = (sql: string): Promise<any[]> => new Promise((resolve, reject) => {
    lifeDb.getLifeDb().all(sql, (err, rows) => err ? reject(err) : resolve(rows as any[]));
  });
  const count = async (table: string): Promise<number> => {
    const rows = await q(`SELECT COUNT(*) as cnt FROM ${table}`);
    return rows[0]?.cnt ?? 0;
  };

  // ══════════════════════════════════════════════════════════
  // ① 开关关闭（默认）：旧 TICK 路径正常写库
  // ══════════════════════════════════════════════════════════
  console.log('\n── ① 开关关闭（p2MigrateEnable=false）：旧 TICK 路径正常写库 ──');
  check('初始开关默认关闭', MIND_SWITCH.p2MigrateEnable === false, `p2MigrateEnable=${MIND_SWITCH.p2MigrateEnable}`);

  const emotionsBefore = await count('emotions');
  const desiresBefore = await count('desires');
  const personalityBefore = await count('personality');

  const e1 = await lifeDb.addEmotion('愉悦', 0.7, 'selftest');
  const d1 = await lifeDb.addDesire('自测欲望-关闭态', 0.5, 'selftest');
  const p1 = await lifeDb.updatePersonality([0.55, 0.55, 0.45, 0.55, 0.50, 0.45, 0.60, 0.50]);
  await lifeDb.saveRelationshipVector([0.30, 0.20, 0.20, 0.30]);
  await lifeDb.decayEmotions();
  await lifeDb.decayDesires();

  check('addEmotion 正常落库（返回正 id）', e1 > 0, `id=${e1}`);
  check('addDesire 正常落库（返回正 id）', d1 > 0, `id=${d1}`);
  check('updatePersonality 正常落库（返回正 id）', p1 > 0, `id=${p1}`);
  check('emotions 行数增加', await count('emotions') === emotionsBefore + 1, `${emotionsBefore} → ${await count('emotions')}`);
  check('desires 行数增加', await count('desires') === desiresBefore + 1, `${desiresBefore} → ${await count('desires')}`);
  const relRows = await q('SELECT vector_json FROM relationship_state WHERE id=1');
  check('relationship_state 落库成功', relRows.length === 1 && JSON.stringify(JSON.parse(relRows[0].vector_json)) === JSON.stringify([0.30, 0.20, 0.20, 0.30]), relRows[0]?.vector_json);
  check('关闭态无 [P2-MIGRATE] 拦截告警', !captured.some(l => l.includes('[P2-MIGRATE]')), `captured=${captured.length} 条`);

  // ══════════════════════════════════════════════════════════
  // ② 开关开启：非 InnerTick 路径（旧 TICK/事件路径）被拦截，不再落库
  // ══════════════════════════════════════════════════════════
  console.log('\n── ② 开关开启（p2MigrateEnable=true）：TICK 写入被拦截，不再落库 ──');
  MIND_SWITCH.p2MigrateEnable = true;
  check('开关已开启', MIND_SWITCH.p2MigrateEnable === true);
  captured.length = 0;

  const emotionsBefore2 = await count('emotions');
  const desiresBefore2 = await count('desires');
  const personalityBefore2 = await count('personality');
  const relBefore2 = relRows[0].vector_json;

  const e2 = await lifeDb.addEmotion('担忧', 0.9, 'selftest-blocked');
  const d2 = await lifeDb.addDesire('自测欲望-开启态', 0.8, 'selftest-blocked');
  const p2 = await lifeDb.updatePersonality([0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99]);
  await lifeDb.saveRelationshipVector([0.9, 0.9, 0.9, 0.9]);
  await lifeDb.decayEmotions();
  await lifeDb.decayDesires();
  await lifeDb.updateDesireStatus(d1, 'completed');

  check('addEmotion 被拦截（返回 -1）', e2 === -1, `id=${e2}`);
  check('addDesire 被拦截（返回 -1）', d2 === -1, `id=${d2}`);
  check('updatePersonality 被拦截（返回 -1）', p2 === -1, `id=${p2}`);
  check('emotions 行数不变（未落库）', await count('emotions') === emotionsBefore2, `${emotionsBefore2} → ${await count('emotions')}`);
  check('desires 行数不变（未落库）', await count('desires') === desiresBefore2, `${desiresBefore2} → ${await count('desires')}`);
  check('personality 行数不变（未落库）', await count('personality') === personalityBefore2, `${personalityBefore2} → ${await count('personality')}`);
  const relAfter2 = (await q('SELECT vector_json FROM relationship_state WHERE id=1'))[0].vector_json;
  check('relationship_state 向量不变（未落库）', relAfter2 === relBefore2, relAfter2);
  const completedRows = await q(`SELECT status FROM desires WHERE id=${d1}`);
  check('updateDesireStatus 被拦截（状态未变更）', completedRows[0].status === 'active', `status=${completedRows[0].status}`);
  check('触发 [P2-MIGRATE] 告警日志', captured.some(l => l.includes('[P2-MIGRATE]')), `捕获 ${captured.filter(l => l.includes('[P2-MIGRATE]')).length} 条`);

  // ══════════════════════════════════════════════════════════
  // ③ 开关开启：InnerTick 统一落库入口（栈含 innerTick.ts）→ 守卫放行，正常落库
  // ══════════════════════════════════════════════════════════
  console.log('\n── ③ 开关开启：仅 InnerTick 可以变更心智状态（统一落库入口）──');
  captured.length = 0;

  const pBefore = (await q('SELECT vector_json FROM personality ORDER BY id DESC LIMIT 1'))[0].vector_json;
  const pVecBefore: number[] = JSON.parse(pBefore);

  const driftOutput: InnerTickOutput = {
    thought: 'P2自测：心智演化推演',
    mood: { name: '平静', intensity: 0.5 },
    desires: [], goals: [], focus: [], archiveItems: [],
    triggerInnerTick: false, memoryHints: [],
    emotionDrift: { name: '满足', intensity: 0.6, change: 0.1 },
    desireEvolve: [
      { content: '自测欲望-LLM生成', intensity: 0.6, status: 'active' },
      { content: '自测欲望-关闭态', intensity: 0.5, status: 'abandoned' }, // 内容匹配既有欲望 → 状态变更
    ],
    personalityDrift: { delta: [0.01, 0, 0, 0, 0, 0, 0, 0] },
    relationshipAdjustment: { vector: [0.6, 0.4, 0.3, 0.2] },
  };

  const emotionsBefore3 = await count('emotions');
  const desiresBefore3 = await count('desires');
  await applyMentalDriftToBusinessState(driftOutput, 'selftest-user');

  const emotionsAfter3 = await count('emotions');
  const desiresAfter3 = await count('desires');
  check('emotion_drift 落库 emotions（+1 行）', emotionsAfter3 === emotionsBefore3 + 1, `${emotionsBefore3} → ${emotionsAfter3}`);
  const newEmo = (await q(`SELECT * FROM emotions ORDER BY id DESC LIMIT 1`))[0];
  check('emotion_drift 内容正确', newEmo.emotion_type === '满足' && Math.abs(newEmo.intensity - 0.6) < 0.001, `${newEmo.emotion_type}(${newEmo.intensity})`);
  check('desire_evolve 新增欲望落库（+1 行）', desiresAfter3 === desiresBefore3 + 1, `${desiresBefore3} → ${desiresAfter3}`);
  const newDes = (await q(`SELECT * FROM desires ORDER BY id DESC LIMIT 1`))[0];
  check('desire_evolve 新增内容正确', newDes.desire_text === '自测欲望-LLM生成' && newDes.source === 'inner_tick', `${newDes.desire_text}(source=${newDes.source})`);
  const abandonedRow = (await q(`SELECT status FROM desires WHERE id=${d1}`))[0];
  check('desire_evolve 既有欲望状态变更（active→abandoned）', abandonedRow.status === 'abandoned', `status=${abandonedRow.status}`);
  const pAfter = (await q('SELECT vector_json FROM personality ORDER BY id DESC LIMIT 1'))[0].vector_json;
  const pVecAfter: number[] = JSON.parse(pAfter);
  check('personality_drift 落库（Δ[0]=+0.01）', Math.abs(pVecAfter[0] - (pVecBefore[0] + 0.01)) < 0.001 && pVecAfter.every((v, i) => Math.abs(v - pVecBefore[i] - (i === 0 ? 0.01 : 0)) < 0.001), `${pVecBefore[0].toFixed(3)} → ${pVecAfter[0].toFixed(3)}`);
  const evoRow = (await q("SELECT * FROM personality_evolution ORDER BY id DESC LIMIT 1"))[0];
  check('personality_drift 记录演化审计', evoRow?.trigger === 'inner_tick', `trigger=${evoRow?.trigger}`);
  const relAfter3 = (await q('SELECT vector_json FROM relationship_state WHERE id=1'))[0].vector_json;
  check('relationship_adjustment 落库', JSON.stringify(JSON.parse(relAfter3)) === JSON.stringify([0.6, 0.4, 0.3, 0.2]), relAfter3);
  check('InnerTick 路径无 [P2-MIGRATE] 拦截告警', !captured.some(l => l.includes('guardP2MentalStateWrite') && l.includes('拦截')), `${captured.filter(l => l.includes('P2-MIGRATE')).length} 条（均为落库埋点）`);

  // ══════════════════════════════════════════════════════════
  // ④ 开关关闭回滚：拦截解除，旧路径恢复写库（一键回滚验证）
  // ══════════════════════════════════════════════════════════
  console.log('\n── ④ 开关关闭回滚：旧路径恢复写库（可回滚）──');
  MIND_SWITCH.p2MigrateEnable = false;
  const desiresBefore4 = await count('desires');
  const d4 = await lifeDb.addDesire('自测欲望-回滚后', 0.4, 'selftest');
  check('回滚后 addDesire 恢复写库（返回正 id）', d4 > 0, `id=${d4}`);
  check('回滚后 desires 行数增加', await count('desires') === desiresBefore4 + 1, `${desiresBefore4} → ${await count('desires')}`);

  // ── 汇总 ──
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`[P2-MIGRATE] 自测结果: ${passCount} PASS / ${failCount} FAIL`);
  console.log('══════════════════════════════════════════════════════════');

  // 清理：关闭连接 + 删除临时库文件
  lifeDb.closeLifeDb();
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* 文件不存在则忽略 */ }
  }

  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[P2-MIGRATE] 自测异常终止:', e);
  try { fs.unlinkSync(TMP_DB); } catch {}
  process.exit(1);
});
