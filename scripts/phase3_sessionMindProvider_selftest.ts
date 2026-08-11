// scripts/phase3_sessionMindProvider_selftest.ts
/**
 * Phase3 自测脚本：InnerTick 灰度会话心智注入层（sessionMindProvider）三场景验证
 *
 *   场景1 普通会话（不在白名单）           → mode=old_life，使用旧life心智
 *   场景2 白名单会话 + 快照存在（取最新一条） → mode=inner_tick_active，使用LLM推演心智
 *   场景3 白名单会话 + 快照缺失            → mode=inner_tick_fallback，自动降级旧life + 告警日志
 *
 * 附加验证：
 *   - 总闸 sessionInnerTickOverride 关闭时，白名单会话也强制走旧life
 *   - 快照 JSON 损坏 / 结构不完整 → 降级 old_life 且不崩溃
 *   - 红线：InnerTick 输出零写入旧life表（emotions/desires/personality 行数与内容均不变）
 *   - 范式守卫 guardSessionMindPersist：白名单表静默、旧life表写入触发告警
 *
 * 隔离性：LIFE_DB_PATH 指向独立临时库（/tmp），绝不触碰生产 life.db；无任何 LLM 网络调用。
 * 本文件名含 sessionMindProvider，使守卫的调用栈白名单检测可命中（与守卫设计一致）。
 */
process.env.LIFE_DB_PATH = '/tmp/peppa_phase3_selftest_life.db';
process.env.PHASE3_INNER_TICK_SESSION_WHITELIST = ''; // 清空环境白名单，保证场景完全由 MIND_SWITCH 控制

import * as fs from 'fs';
const DB = process.env.LIFE_DB_PATH!;
for (const f of [DB, DB + '-wal', DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 首次运行无残留 */ }
}

const { MIND_SWITCH } = await import('../src/config/mindSwitch');
const lifeDb = await import('../server/db/lifeDb');
const { logger } = await import('../server/lib/logger');
const { resolveSessionMind } = await import('../src/core/sessionMindProvider');
const { guardSessionMindPersist } = await import('../src/utils/paradigmGuard');

// 拦截 logger.warn（同步捕获，用于断言降级告警日志是否输出）
const warns: string[] = [];
const infos: string[] = [];
const origWarn = logger.warn.bind(logger);
const origInfo = logger.info.bind(logger);
logger.warn = ((...args: unknown[]) => { warns.push(args.join(' ')); origWarn(...args); }) as typeof logger.warn;
logger.info = ((...args: unknown[]) => { infos.push(args.join(' ')); origInfo(...args); }) as typeof logger.info;

await lifeDb.migrateLifeTables();
const db = lifeDb.getLifeDb();

function dbGet<T>(sql: string): Promise<T> {
  return new Promise((resolve, reject) =>
    db.get(sql, (err, row) => (err ? reject(err) : resolve(row as T))));
}

async function countRows(table: string): Promise<number> {
  const row = await dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
  return row.c;
}

// ── 测试用 InnerTick 快照样例（结构对齐 InnerTickOutput schema）──
const SAMPLE_OUTPUT_1 = {
  thought: '第一轮推演：与用户初见，保持从容。',
  mood: { name: '期待', intensity: 0.6 },
  desires: [{ id: '11111111-1111-4111-8111-111111111111', content: '认识用户并建立信任', intensity: 0.5, status: 'active' }],
  goals: [{ id: '22222222-2222-4222-8222-222222222222', content: '完成首次对话', status: 'active' }],
  focus: [{ id: '33333333-3333-4333-8333-333333333333', content: '初次对话氛围' }],
  archiveItems: [],
  triggerInnerTick: true,
  memoryHints: ['用户初识'],
};
const SAMPLE_OUTPUT_2 = {
  thought: '第二轮推演：用户提到工作压力，我希望能多陪ta聊聊。',
  mood: { name: '关切', intensity: 0.8 },
  desires: [{ id: '11111111-1111-4111-8111-111111111111', content: '更深入地陪伴用户缓解压力', intensity: 0.7, status: 'active' }],
  goals: [{ id: '22222222-2222-4222-8222-222222222222', content: '记住用户最近的烦恼点', status: 'active' }],
  focus: [{ id: '33333333-3333-4333-8333-333333333333', content: '用户的工作压力与情绪状态' }],
  archiveItems: [],
  triggerInnerTick: true,
  memoryHints: ['用户近期工作压力大'],
};

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n════════ Phase3 灰度会话心智自测 ════════\n');

// ─────────────────────────────
// 场景1：普通会话（不在白名单）→ old_life
// ─────────────────────────────
console.log('── 场景1：普通会话（不在白名单）→ 旧life心智 ──');
MIND_SWITCH.sessionInnerTickOverride = true;
MIND_SWITCH.overrideSessionWhitelist = ['session-B', 'session-C', 'session-D', 'session-E'];
const s1 = await resolveSessionMind('session-A');
check('mode=old_life', s1.mode === 'old_life', `实际=${s1.mode}`);
check('snapshotId=null', s1.snapshotId === null, `实际=${s1.snapshotId}`);
check('innerOutput=null（未注入InnerTick）', s1.innerOutput === null);
check('old_life 情绪/人格向量 8 维', s1.emotionVector.length === 8 && s1.personalityVector.length === 8);
check('old_life 无 InnerTick prompt 文本', s1.innerMindPromptText === '');
check('日志: mode=old_life 已输出', infos.some((l) => l.includes('[Phase3-MindProvider]') && l.includes('session=session-A') && l.includes('mode=old_life')));

// ─────────────────────────────
// 场景2：白名单会话 + 快照存在（取最新一条）→ inner_tick_active
// ─────────────────────────────
console.log('\n── 场景2：白名单会话 + InnerTick快照存在 → LLM推演心智 ──');
const id1 = await lifeDb.insertInnerTickSnapshot({ sessionId: 'session-B', userUid: 'selftest', turnIndex: 1, innerOutput: SAMPLE_OUTPUT_1, triggerSource: 'chat_turn' });
const id2 = await lifeDb.insertInnerTickSnapshot({ sessionId: 'session-B', userUid: 'selftest', turnIndex: 2, innerOutput: SAMPLE_OUTPUT_2, triggerSource: 'chat_turn' });
const s2 = await resolveSessionMind('session-B');
check('mode=inner_tick_active', s2.mode === 'inner_tick_active', `实际=${s2.mode}`);
check('取最新一条快照（turn2）', s2.snapshotId === id2, `快照id=${s2.snapshotId} 期望=${id2}`);
check('注入 InnerTick 完整输出', s2.innerOutput?.thought === SAMPLE_OUTPUT_2.thought);
check('情绪向量由 mood 映射（关切→平静维=0.8）', s2.emotionVector[1] === 0.8, `v[1]=${s2.emotionVector[1]}`);
check('人格向量沿用旧life（8维）', s2.personalityVector.length === 8);
check('prompt 注入情绪/欲望/目标/自我反思', s2.innerMindPromptText.includes('主导情绪') && s2.innerMindPromptText.includes('活跃欲望') && s2.innerMindPromptText.includes('当前目标') && s2.innerMindPromptText.includes('内心独白') && s2.innerMindPromptText.includes('更深入地陪伴用户缓解压力'));
check('日志: mode=inner_tick_active 已输出', infos.some((l) => l.includes('[Phase3-MindProvider]') && l.includes(`session=session-B`) && l.includes(`mode=inner_tick_active`) && l.includes(`snapshotId=${id2}`)));

// ─────────────────────────────
// 场景3：白名单会话 + 快照缺失 → inner_tick_fallback + 告警
// ─────────────────────────────
console.log('\n── 场景3：白名单会话 + 快照缺失 → 自动降级旧life ──');
const s3 = await resolveSessionMind('session-C');
check('mode=inner_tick_fallback', s3.mode === 'inner_tick_fallback', `实际=${s3.mode}`);
check('降级为旧life心智（无InnerTick注入）', s3.innerOutput === null && s3.snapshotId === null);
check('降级后向量仍 8 维', s3.emotionVector.length === 8);
check('告警日志已输出（fallback 明确告警）', warns.some((l) => l.includes('[Phase3-MindProvider]') && l.includes('session=session-C') && l.includes('mode=inner_tick_fallback') && l.includes('告警')));

// ── 附加：总闸关闭 → 白名单会话也强制走旧life ──
console.log('\n── 附加1：总闸 sessionInnerTickOverride=false → 白名单会话强制旧life ──');
MIND_SWITCH.sessionInnerTickOverride = false;
const s1b = await resolveSessionMind('session-B');
MIND_SWITCH.sessionInnerTickOverride = true;
check('白名单会话在总闸关闭时 mode=old_life', s1b.mode === 'old_life', `实际=${s1b.mode}`);

// ── 附加：快照 JSON 损坏 → 降级 ──
console.log('\n── 附加2：快照 JSON 损坏 → 降级旧life ──');
const corruptId = await lifeDb.insertInnerTickSnapshot({ sessionId: 'session-D', userUid: 'selftest', turnIndex: 1, innerOutput: { thought: '占位' }, triggerSource: 'chat_turn' });
// 直接改库制造真实损坏 JSON（insertInnerTickSnapshot 会 JSON.stringify，无法从 API 写入非法 JSON）
await new Promise<void>((resolve, reject) =>
  db.run("UPDATE inner_tick_snapshot SET inner_output = '{broken json' WHERE id = ?", [corruptId], (err) => (err ? reject(err) : resolve())));
const s4 = await resolveSessionMind('session-D');
check('mode=inner_tick_fallback 且不崩溃', s4.mode === 'inner_tick_fallback', `实际=${s4.mode}`);
check('JSON损坏告警日志已输出', warns.some((l) => l.includes('session=session-D') && l.includes('快照JSON解析失败')));

// ── 附加：快照结构不完整（无 mood）→ 降级 ──
console.log('\n── 附加3：快照结构不完整（mood缺失）→ 降级旧life ──');
await lifeDb.insertInnerTickSnapshot({ sessionId: 'session-E', userUid: 'selftest', turnIndex: 1, innerOutput: { thought: '缺少mood字段' } as any, triggerSource: 'chat_turn' });
const s5 = await resolveSessionMind('session-E');
check('mode=inner_tick_fallback 且不崩溃', s5.mode === 'inner_tick_fallback', `实际=${s5.mode}`);
check('结构异常告警日志已输出', warns.some((l) => l.includes('session=session-E') && l.includes('快照结构不完整')));

// ── 红线：InnerTick 输出零写入旧life表 ──
console.log('\n── 红线：InnerTick 输出不得写入旧life持久表 ──');
// 预热后计数（引擎自身基线写入属于旧life既有行为，与InnerTick无关；预热后再对比）
await resolveSessionMind('session-B');
const beforeE = await countRows('emotions');
const beforeD = await countRows('desires');
const beforeP = await countRows('personality');
await resolveSessionMind('session-B'); // 再次B模式解析（读取快照）
await resolveSessionMind('session-C'); // 降级路径
const afterE = await countRows('emotions');
const afterD = await countRows('desires');
const afterP = await countRows('personality');
check('emotions 行数不变（零写入）', beforeE === afterE, `${beforeE} → ${afterE}`);
check('desires 行数不变（零写入）', beforeD === afterD, `${beforeD} → ${afterD}`);
check('personality 行数不变（零写入）', beforeP === afterP, `${beforeP} → ${afterP}`);
const leakDesire = await dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM desires WHERE desire_text LIKE '%更深入地陪伴用户缓解压力%'");
const leakEmotion = await dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM emotions WHERE emotion_type LIKE '%关切%' OR context LIKE '%工作压力%'");
check('InnerTick欲望内容未渗入 desires 表', leakDesire.c === 0, `命中=${leakDesire.c}`);
check('InnerTick情绪内容未渗入 emotions 表', leakEmotion.c === 0, `命中=${leakEmotion.c}`);
check('inner_tick_snapshot 仅含测试写入的4条', (await countRows('inner_tick_snapshot')) === 4, `实际=${await countRows('inner_tick_snapshot')}`);

// ── 范式守卫：guardSessionMindPersist ──
console.log('\n── 范式守卫：guardSessionMindPersist（Phase3 新守卫）──');
const captured: string[] = [];
const origErr = console.error;
console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
guardSessionMindPersist('inner_tick_snapshot', '白名单表探针'); // 应静默
guardSessionMindPersist('emotions', '违规写入探针');            // 应告警（本文件路径含 sessionMindProvider）
console.error = origErr;
// 告警消息正文含「持久存储仅 inner_tick_snapshot」字样，不能按子串判断白名单；按告警条数判断：
// 白名单表调用必须静默（不产生第2条 guardSessionMindPersist 告警）
const guardWarnings = captured.filter((l) => l.includes('guardSessionMindPersist'));
check('白名单表 inner_tick_snapshot 静默通过（仅1条告警=emotions）', guardWarnings.length === 1, `实际告警数=${guardWarnings.length}`);
check('旧life表 emotions 触发范式告警', guardWarnings.length === 1 && guardWarnings[0].includes('emotions') && guardWarnings[0].includes('Phase3'));

// ── 汇总 ──
console.log(`\n════════ 自测结果: ${pass} 通过 / ${fail} 失败 ════════\n`);
if (fail > 0) {
  console.error('Phase3 自测存在失败项，请检查。');
  process.exit(1);
}

// 等待 pino 日志刷新后退出
await new Promise((r) => setTimeout(r, 500));
// 清理临时库
for (const f of [DB, DB + '-wal', DB + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* 已清理 */ }
}
console.log('临时测试库已清理: /tmp/peppa_phase3_selftest_life.db');
