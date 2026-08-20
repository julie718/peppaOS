// p2_migrate_selftest.ts — P2迁移自测脚本（自包含，无外部依赖）
// 覆盖：
//   ① 开关关闭（默认 false）：旧 TICK 路径写 emotions/desires/personality/relationship_state 正常落库（维持原有行为）；
//   ② 开关开启：非 InnerTick 路径写入被 paradigmGuard 拦截（返回 -1 / 跳过 SQL），触发 [P2-MIGRATE] 告警，数据不变；
//   ③ 开关开启：InnerTick 路径（runInnerTick 统一落库入口 applyMentalDriftToBusinessState）经守卫校验后正常落库；
//   ④ 开关关闭回滚：拦截解除，旧路径恢复写库（一键回滚验证）；
//   ⑤ 新增：InnerTick LLM 调用超时（AbortController signal 300ms）→ [InnerTick-ERROR] 超时告警 + 本轮零写入；
//   ⑥ 新增：模型仅输出 reasoning、content 为空（deepseek-v4-flash 已知异常）→ [InnerTick-ERROR] 格式告警 + 本轮零写入。
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
  const { applyMentalDriftToBusinessState, runInnerTick } = await import('./src/core/innerTick');

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
  // 显式置 OFF：与部署配置（p2MigrateEnable=true）解耦，本段固定验证关闭态行为
  MIND_SWITCH.p2MigrateEnable = false;
  check('开关已显式关闭（OFF 态）', MIND_SWITCH.p2MigrateEnable === false, `p2MigrateEnable=${MIND_SWITCH.p2MigrateEnable}`);

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
    isPublic: false, // Phase2 铁则：内部推演默认不对外
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

  // ══════════════════════════════════════════════════════════
  // ⑤ 新增：InnerTick LLM 调用超时（AbortController signal）→ 超时告警 + 本轮心智业务表零写入
  // ══════════════════════════════════════════════════════════
  console.log('\n── ⑤ InnerTick LLM 调用超时（mindSwitch 阈值压至 300ms）→ 超时告警 + 本轮零写入 ──');

  // 模拟真实 LLM 调用挂起：仅响应超时 signal 中止（reject AbortError），其余时间永不返回
  const abortErr = new Error('This operation was aborted');
  abortErr.name = 'AbortError';
  const hangingClient: any = {
    chat: { completions: { create: (_params: any, opts?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        if (opts?.signal?.aborted) { reject(abortErr); return; }
        opts?.signal?.addEventListener('abort', () => reject(abortErr), { once: true });
      }) } },
  };
  // 全 provider 注入同一 mock（测试环境无用户偏好 → 默认走 deepseek，注入兜底保证确定性）
  const allGetters = (client: any) => ({
    getDeepSeek: () => client, getGemini: () => client, getOpenAI: () => client, getAnthropic: () => client,
    getQwen: () => client, getOllama: () => client, getLmStudio: () => client, getArk: () => client,
    getXiaomi: () => client, getKimi: () => client, getGlm: () => client, getRelay: () => client,
  });

  const origTimeoutMs = MIND_SWITCH.innerTickLLMTimeoutMs;
  MIND_SWITCH.innerTickLLMTimeoutMs = 300;   // 测试压到 300ms（生产默认 45000，见 mindSwitch.ts）
  MIND_SWITCH.p2MigrateEnable = true;        // 生产同态：迁移总闸开启下验证超时零写入
  captured.length = 0;

  const emotionsBefore5 = await count('emotions');
  const desiresBefore5 = await count('desires');
  const personalityBefore5 = await count('personality');
  const relBefore5 = (await q('SELECT vector_json FROM relationship_state WHERE id=1'))[0]?.vector_json;
  const snapBefore5 = await count('inner_tick_snapshot');
  const sysSnapBefore5 = (await q(`SELECT COUNT(*) as cnt FROM system_events WHERE event_type='inner_tick_snapshot'`))[0].cnt;

  // 捕获 InnerTick 分级日志：直接 patch logger.warn/error（innerTick 经 logger 属性调用，同步可捕获；
  // pino transport 异步写 stdout，断言前不可靠）
  const { logger } = await import('./server/lib/logger');
  const innerTickLogs5: string[] = [];
  const origLogWarn5 = logger.warn;
  const origLogError5 = logger.error;
  logger.warn = (...args: unknown[]) => { innerTickLogs5.push(args.map(String).join(' ')); origLogWarn5(...args); };
  logger.error = (...args: unknown[]) => { innerTickLogs5.push(args.map(String).join(' ')); origLogError5(...args); };
  let out5: InnerTickOutput;
  try {
    out5 = await runInnerTick({
      userId: 'selftest-timeout',
      sessionId: 'conv_selftest_timeout',
      triggerSource: 'manual',
      llmGetters: allGetters(hangingClient),
    });
  } finally {
    logger.warn = origLogWarn5;
    logger.error = origLogError5;
    MIND_SWITCH.innerTickLLMTimeoutMs = origTimeoutMs;  // 恢复生产阈值
  }
  const stdout5 = innerTickLogs5.join('\n');

  check('⑤ 超时后返回兜底输出（本轮无推演结果）', !out5.triggerInnerTick && out5.desires.length === 0 && !out5.emotionDrift, `trigger=${out5.triggerInnerTick} desires=${out5.desires.length}`);
  check('⑤ 输出 [InnerTick-ERROR] LLM调用超时（kind=llm_timeout）分类日志', stdout5.includes('[InnerTick-ERROR]') && stdout5.includes('LLM调用超时') && stdout5.includes('kind=llm_timeout'), '');
  check('⑤ 输出 [InnerTick-WARN] 超时中止在途请求告警（分级日志）', stdout5.includes('[InnerTick-WARN]') && stdout5.includes('已中止在途请求'), '');
  check('⑤ emotions 零写入', await count('emotions') === emotionsBefore5, `${emotionsBefore5} → ${await count('emotions')}`);
  check('⑤ desires 零写入', await count('desires') === desiresBefore5, `${desiresBefore5} → ${await count('desires')}`);
  check('⑤ personality 零写入', await count('personality') === personalityBefore5, `${personalityBefore5} → ${await count('personality')}`);
  const relAfter5 = (await q('SELECT vector_json FROM relationship_state WHERE id=1'))[0]?.vector_json;
  check('⑤ relationship_state 零写入', relAfter5 === relBefore5, `${relBefore5} → ${relAfter5}`);
  check('⑤ inner_tick_snapshot 观测表零写入', await count('inner_tick_snapshot') === snapBefore5, `${snapBefore5} → ${await count('inner_tick_snapshot')}`);
  const sysSnapAfter5 = (await q(`SELECT COUNT(*) as cnt FROM system_events WHERE event_type='inner_tick_snapshot'`))[0].cnt;
  check('⑤ life.db 快照备份零写入', sysSnapAfter5 === sysSnapBefore5, `${sysSnapBefore5} → ${sysSnapAfter5}`);

  // ══════════════════════════════════════════════════════════
  // ⑥ 新增：模型只输出 reasoning、content 为空（deepseek-v4-flash 已知异常）→ 格式告警 + 本轮零写入
  // ══════════════════════════════════════════════════════════
  console.log('\n── ⑥ 模型仅输出 reasoning、content 为空（deepseek-v4-flash 已知异常）→ 格式告警 + 本轮零写入 ──');
  captured.length = 0;

  const reasoningOnlyClient: any = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { role: 'assistant', content: null, reasoning_content: '（思考链）本轮推演内部思考过程……但未输出任何有效 content' } }],
    }) } },
  };

  const emotionsBefore6 = await count('emotions');
  const desiresBefore6 = await count('desires');
  const personalityBefore6 = await count('personality');
  const relBefore6 = (await q('SELECT vector_json FROM relationship_state WHERE id=1'))[0]?.vector_json;
  const snapBefore6 = await count('inner_tick_snapshot');
  const sysSnapBefore6 = (await q(`SELECT COUNT(*) as cnt FROM system_events WHERE event_type='inner_tick_snapshot'`))[0].cnt;

  const innerTickLogs6: string[] = [];
  const origLogWarn6 = logger.warn;
  const origLogError6 = logger.error;
  logger.warn = (...args: unknown[]) => { innerTickLogs6.push(args.map(String).join(' ')); origLogWarn6(...args); };
  logger.error = (...args: unknown[]) => { innerTickLogs6.push(args.map(String).join(' ')); origLogError6(...args); };
  let out6: InnerTickOutput;
  try {
    out6 = await runInnerTick({
      userId: 'selftest-reasoning',
      sessionId: 'conv_selftest_reasoning',
      triggerSource: 'manual',
      llmGetters: allGetters(reasoningOnlyClient),
    });
  } finally {
    logger.warn = origLogWarn6;
    logger.error = origLogError6;
  }
  const stdout6 = innerTickLogs6.join('\n');

  check('⑥ 返回兜底输出（本轮无推演结果）', !out6.triggerInnerTick && out6.desires.length === 0 && !out6.emotionDrift, `trigger=${out6.triggerInnerTick} desires=${out6.desires.length}`);
  check('⑥ 输出 [InnerTick-ERROR] reasoning_only 格式分类日志', stdout6.includes('[InnerTick-ERROR]') && stdout6.includes('kind=reasoning_only') && stdout6.includes('仅输出 reasoning'), '');
  check('⑥ 首次失败输出 [InnerTick-WARN] 重试告警（分级日志）', stdout6.includes('[InnerTick-WARN]') && stdout6.includes('kind=reasoning_only'), '');
  check('⑥ emotions 零写入', await count('emotions') === emotionsBefore6, `${emotionsBefore6} → ${await count('emotions')}`);
  check('⑥ desires 零写入', await count('desires') === desiresBefore6, `${desiresBefore6} → ${await count('desires')}`);
  check('⑥ personality 零写入', await count('personality') === personalityBefore6, `${personalityBefore6} → ${await count('personality')}`);
  const relAfter6 = (await q('SELECT vector_json FROM relationship_state WHERE id=1'))[0]?.vector_json;
  check('⑥ relationship_state 零写入', relAfter6 === relBefore6, `${relBefore6} → ${relAfter6}`);
  check('⑥ inner_tick_snapshot 观测表零写入', await count('inner_tick_snapshot') === snapBefore6, `${snapBefore6} → ${await count('inner_tick_snapshot')}`);
  const sysSnapAfter6 = (await q(`SELECT COUNT(*) as cnt FROM system_events WHERE event_type='inner_tick_snapshot'`))[0].cnt;
  check('⑥ life.db 快照备份零写入', sysSnapAfter6 === sysSnapBefore6, `${sysSnapBefore6} → ${sysSnapAfter6}`);

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
