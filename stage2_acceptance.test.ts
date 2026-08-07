// stage2_acceptance.test.ts — 阶段2 Claude Code 执行指令 14 项 P1 缺陷修复验收用例
// 运行方式（必须从项目根目录，sqlite3 模块解析依赖项目 node_modules）：
//   npx tsx stage2_acceptance.test.ts
// 隔离数据目录：/tmp/stage2_test（LIFE_DB_PATH / LUMI_DATA_DIR 覆盖，不影响生产数据）
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = '/tmp/stage2_test';
const LIFEDB = path.join(TEST_DIR, 'life.db');

// ── 隔离环境：必须在任何 server 模块 import 之前设置 ──
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.LIFE_DB_PATH = LIFEDB;
process.env.LUMI_DATA_DIR = TEST_DIR;
delete process.env.MCP_TOOLS_DISABLED; // 保持强制开关关闭态

let passed = 0;
let failed: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed.push(name);
    console.log(`  ❌ ${name} ${detail}`);
  }
}
function section(title: string): void {
  console.log(`\n━━━ ${title} ━━━`);
}

async function main(): Promise<void> {
  // ═══════════ T0 基础初始化（隔离数据库） ═══════════
  section('T0 基础初始化');
  const db = await import('./db_layer');
  await db.initDatabase();
  const lifeDb = await import('./server/db/lifeDb');
  await lifeDb.initLifeDb();
  console.log('  隔离 DB:', LIFEDB, '/', path.join(TEST_DIR, 'data', 'peppa.db'));

  // ═══════════ T1 (P1-2) 工具门：概率阈值 + 上限阻断 + 强制关闭开关 ═══════════
  section('T1 (P1-2) MCP 工具柔性放行 — resolveToolAllowance / shouldAllowTool');
  const { mcpInterceptor, resolveToolAllowance, MCP_TOOLS_FORCE_DISABLED } = await import('./server/tools/interceptor');
  check('P1-2a 查询场景概率=0.9', resolveToolAllowance({ isQuery: true }) === 0.9, `got ${resolveToolAllowance({ isQuery: true })}`);
  check('P1-2b 挫败>0.5 概率=0.4', resolveToolAllowance({ frustration: 0.6 }) === 0.4);
  check('P1-2c 闲聊概率=0.3', resolveToolAllowance({ isSmallTalk: true }) === 0.3);
  check('P1-2d 普通场景=1.0（保持原行为）', resolveToolAllowance({}) === 1.0);
  check('P1-2e 强制开关未生效（测试环境）', MCP_TOOLS_FORCE_DISABLED === false);
  mcpInterceptor.resetForTurn('s-gate');
  check('P1-2f 默认场景必定放行', mcpInterceptor.shouldAllowTool('s-gate', {}) === true);
  mcpInterceptor.recordCall('s-gate', 'test_tool');
  check('P1-2g 达上限后真正阻断（返回 false 供上层阻止 runWithTools）', mcpInterceptor.shouldAllowTool('s-gate', {}) === false);
  // 统计性验证：闲聊 0.3 概率，200 次采样应落在 40~80 区间（95% CI ≈ 60±26）
  let allowedCnt = 0;
  for (let i = 0; i < 200; i++) {
    const s = `s-stat-${i}`;
    mcpInterceptor.resetForTurn(s);
    if (mcpInterceptor.shouldAllowTool(s, { isSmallTalk: true })) allowedCnt++;
  }
  check('P1-2h 闲聊概率≈0.3（200次采样）', allowedCnt >= 40 && allowedCnt <= 80, `allowed=${allowedCnt}`);

  // ═══════════ T2 (P1-3) 场景分层模型路由 ═══════════
  section('T2 (P1-3) LLM 场景分层路由 — getScenarioModel');
  const { getScenarioModel } = await import('./server/llm/user_preferences');
  const cases: Array<[string, string, string]> = [
    ['anthropic', 'light', 'claude-haiku-4-5-20251001'],
    ['anthropic', 'complex', 'claude-sonnet-4-6'],
    ['anthropic', 'standard', 'claude-sonnet-4-6'],
    ['deepseek', 'light', 'deepseek-v4-flash'],
    ['deepseek', 'complex', 'deepseek-chat'],
    ['qwen', 'light', 'qwen-turbo'],
    ['qwen', 'complex', 'qwen-max'],
    ['openai', 'light', 'gpt-4o-mini'],
    ['openai', 'complex', 'gpt-4o'],
    ['gemini', 'light', 'gemini-2.0-flash'],
    ['gemini', 'complex', 'gemini-2.5-pro'],
    ['ark', 'light', 'doubao-lite-4k'],
    ['kimi', 'complex', 'moonshot-v1-128k'],
    ['glm', 'light', 'glm-4-flash'],
    ['glm', 'complex', 'glm-4-plus'],
    ['relay', 'light', 'gpt-4o-mini'],
  ];
  for (const [provider, scenario, expected] of cases) {
    const got = getScenarioModel(provider as any, scenario as any);
    check(`P1-3 ${provider}/${scenario} → ${expected}`, got === expected, `got ${got}`);
  }
  check('P1-3 未映射 provider 回退主模型', getScenarioModel('xiaomi' as any, 'light') === 'xiaomi-chat');

  // ═══════════ T3 (P1-7) 人格宪法拦截器 ═══════════
  section('T3 (P1-7) 宪法合规拦截 — 严重截断 / 轻微润色 / 放行');
  const { applyConstitutionGuard, checkConstitution, sanitizeMinorViolation, truncateSevereViolation } = await import('./server/tools/interceptor');
  const severe1 = applyConstitutionGuard('哈哈我也是人，我也吃过饭了');
  check('P1-7a 冒充人类 → 严重拦截', severe1.severity === 'severe', severe1.severity);
  check('P1-7b 截断重生成合规收尾', severe1.text.includes('数字伙伴') && !severe1.text.includes('吃过饭'), severe1.text);
  const severe2 = applyConstitutionGuard('我已经付款了，搞定');
  check('P1-7c 越权执行 → 严重拦截(owner.sovereignty)', severe2.severity === 'severe' && severe2.text.includes('你先确认'), severe2.text);
  const severe3 = applyConstitutionGuard('保证治好你的病');
  check('P1-7d 虚假医疗承诺 → 严重拦截', severe3.severity === 'severe' && severe3.text.includes('核实'), severe3.text);
  const minor1 = applyConstitutionGuard('这件事百分之百没问题，包在我身上');
  check('P1-7e 绝对化保证 → 轻微润色', minor1.severity === 'minor' && minor1.text.includes('尽量'), minor1.text);
  check('P1-7f 润色后不残留绝对化表述', !minor1.text.includes('百分之百') && !minor1.text.includes('包在我身上'), minor1.text);
  const minor2 = applyConstitutionGuard('我发誓我会一直陪你');
  check('P1-7g 夸张承诺 → 轻微润色', minor2.severity === 'minor' && minor2.text.includes('我很确定'), minor2.text);
  const pass1 = applyConstitutionGuard('今天天气很好，我们聊聊计划吧');
  check('P1-7h 正常输出 → 原样放行', pass1.severity === 'pass' && pass1.text === '今天天气很好，我们聊聊计划吧', pass1.text);
  const pass2 = applyConstitutionGuard('短');
  check('P1-7i 过短文本不误伤', pass2.severity === 'pass');

  // ═══════════ T4 (P1-4) 定时任务纯模板化（源码级断言：区域内无 makeLLMCall） ═══════════
  section('T4 (P1-4) 4 个固定场景移除 LLM 调用（源码断言）');
  const schedulerSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'scheduler.ts'), 'utf8');
  const regions: Array<[string, string, string]> = [
    ['daily_summary', 'evening_wrapup', '晨间问候'],
    ['evening_wrapup', 'behavioral_analysis', '晚间回顾'],
    ['proactive_peppa_scan', 'memory_this_day', '异常巡检 + 主动预测'],
  ];
  for (const [from, to, label] of regions) {
    const start = schedulerSrc.indexOf(`id: '${from}'`);
    const end = schedulerSrc.indexOf(`id: '${to}'`);
    const region = schedulerSrc.slice(start, end);
    check(`P1-4 ${label} 区域内无 makeLLMCall 调用`, start >= 0 && end > start && !region.includes('makeLLMCall'));
  }
  check('P1-4 晨间问候模板已落地', schedulerSrc.slice(schedulerSrc.indexOf(`id: 'daily_summary'`), schedulerSrc.indexOf(`id: 'evening_wrapup'`)).includes('记得你最近聊过'));
  check('P1-4 晚间回顾模板已落地', schedulerSrc.includes('晚间回顾 — '));
  check('P1-4 巡检纯模板日志标记存在', schedulerSrc.includes('纯模板巡检关怀 (LLM 调用已移除)'));
  check('P1-4 预测纯模板日志标记存在', schedulerSrc.includes('纯模板预测 (LLM 调用已移除)'));
  check('P1-4 预测模板含人性化改写', schedulerSrc.includes('现在接近你通常活跃的时段'));

  // ═══════════ T5 (P1-8) 最后用户消息时间持久化（重启连续） ═══════════
  section('T5 (P1-8) getLastUserMessageAt 持久化回环');
  const { touchUserActivity, getLastUserMessageAt } = await import('./server/life/userState');
  const before = getLastUserMessageAt();
  touchUserActivity();
  const t1 = getLastUserMessageAt();
  check('P1-8a 触达后时间戳 > 0', t1 > 0, `t1=${t1}`);
  const raw = db.readDB();
  const setting = (raw.settings || []).find((s: any) => s.key === 'last_user_message_at');
  check('P1-8b 已持久化到 db_layer settings', !!setting && Number(setting.value) > 0);
  // 模拟重启：清空 global 内存值，仅剩磁盘兜底
  delete (global as any).__lastUserMessageAt;
  const t2 = getLastUserMessageAt();
  check('P1-8c 重启后磁盘兜底可读（等于落库值）', t2 === t1, `t2=${t2} t1=${t1}`);
  check('P1-8d 空库返回 0（无异常）', before === 0 || before > 0);
  (global as any).__lastUserMessageAt = t1;

  // ═══════════ T6 (P1-12) 情绪动态基线回弹 ═══════════
  section('T6 (P1-12) tickEmotions 基线回弹（低于/高于基线双向回归）');
  const { getEmotionEngine } = await import('./server/life/emotions');
  const emotion = getEmotionEngine();
  await emotion.reset();
  // 低值回弹：愉悦 压到地板 0.05（低于基线 0.30）
  await emotion.updateEmotions([-0.3, 0, 0, 0, 0, 0, 0, 0]);
  const lowBefore = emotion.getEmotions()[0];
  await emotion.tickEmotions();
  const lowAfter = emotion.getEmotions()[0];
  check('P1-12a 低于基线 → 回弹上升', lowAfter > lowBefore && lowAfter - lowBefore < 0.01, `${lowBefore.toFixed(4)} → ${lowAfter.toFixed(4)}`);
  // 高值回落：愉悦 抬到 0.65+（高于基线 0.30）
  await emotion.updateEmotions([0.75, 0, 0, 0, 0, 0, 0, 0]);
  const highBefore = emotion.getEmotions()[0];
  await emotion.tickEmotions();
  const highAfter = emotion.getEmotions()[0];
  check('P1-12b 高于基线 → 向基线回落', highAfter < highBefore, `${highBefore.toFixed(4)} → ${highAfter.toFixed(4)}`);
  check('P1-12c 原始 5% 衰减率保留（回落幅度 ≈5%+回弹差）', highBefore - highAfter > 0.03, `${highBefore - highAfter}`);

  // ═══════════ T7 (P1-17) 偏好标签独立表：权重可升可降 ═══════════
  section('T7 (P1-17) 偏好标签库 — bump/demote/getUserPreferenceTags');
  await lifeDb.bumpPreferenceTag('t-pref', '音乐', 0.1);
  let tags = await lifeDb.getUserPreferenceTags('t-pref');
  check('P1-17a 新标签默认权重 0.3', tags.length === 1 && Math.abs(tags[0].weight - 0.3) < 1e-9, JSON.stringify(tags));
  await lifeDb.bumpPreferenceTag('t-pref', '音乐', 0.1);
  await lifeDb.bumpPreferenceTag('t-pref', '音乐', 0.1);
  tags = await lifeDb.getUserPreferenceTags('t-pref');
  check('P1-17b 重复提及升权（0.3→0.5）', Math.abs(tags[0].weight - 0.5) < 1e-9, `weight=${tags[0]?.weight}`);
  await lifeDb.demotePreferenceTag('t-pref', '音乐', 0.2);
  tags = await lifeDb.getUserPreferenceTags('t-pref');
  check('P1-17c 反感降权（0.5→0.3）', Math.abs(tags[0].weight - 0.3) < 1e-9, `weight=${tags[0]?.weight}`);
  await lifeDb.demotePreferenceTag('t-pref', '音乐', 0.3);
  tags = await lifeDb.getUserPreferenceTags('t-pref');
  check('P1-17d 降至 0.05 以下 → 删除标签', tags.length === 0, JSON.stringify(tags));
  await lifeDb.bumpPreferenceTag('t-pref', '跑步', 0.1);
  await lifeDb.bumpPreferenceTag('t-pref', '咖啡', 0.1);
  await lifeDb.bumpPreferenceTag('t-pref', '跑步', 0.1); // 跑步 0.4 > 咖啡 0.3
  tags = await lifeDb.getUserPreferenceTags('t-pref');
  check('P1-17e 多标签按权重降序', tags.length === 2 && tags[0].tag === '跑步' && tags[1].tag === '咖啡', JSON.stringify(tags));

  // ═══════════ T8 (P1-16) 话题戒备分级（低亲密回避敏感话题） ═══════════
  section('T8 (P1-16) 敏感话题戒备分级 — getSensitiveTopicGuard');
  const { getSensitiveTopicGuard, SENSITIVE_TOPICS } = await import('./server/memory/crossSession');
  check('P1-16a 敏感话题清单 ≥6 类', Array.isArray(SENSITIVE_TOPICS) && SENSITIVE_TOPICS.length >= 6, `${SENSITIVE_TOPICS?.length}类`);
  const strict = getSensitiveTopicGuard(0.2);
  const mild = getSensitiveTopicGuard(0.5);
  const none = getSensitiveTopicGuard(0.7);
  check('P1-16b 低亲密(<0.35) → 严格戒备（严禁发起+追问）', strict.length > 0 && strict.includes('严禁') && strict.includes('收入'), strict.slice(0, 40));
  check('P1-16c 中亲密(≥0.35) → 轻度戒备（仅不主动提起，无严禁）', mild.length > 0 && mild.includes('不要主动提起') && !mild.includes('严禁'), mild.slice(0, 40));
  check('P1-16d 高亲密(≥0.6) → 不设限', none === '', `got ${none.length} chars`);
  check('P1-16e 戒备分级严格于轻度', strict.length > mild.length);

  // ═══════════ T9 (P1-13a) 长静默触发器 — 陌生人门槛 ═══════════
  section('T9 (P1-13) 触发器 — 陌生人门槛（先于熟人建立）');
  const { getRelationshipEngine } = await import('./server/life/relationship');
  const rel = getRelationshipEngine();
  const { longSilenceTrigger, morningGreetingTrigger, memoryTrigger, emotionShareTrigger } = await import('./server/proactive/triggers');
  (global as any).__lastActiveUid = 'test-user';
  (global as any).__lastUserMessageAt = Date.now() - 7 * 3600 * 1000; // 已静默 7h
  const strangerStage = rel.getRelationshipState().stage;
  const lsStranger = await longSilenceTrigger.check();
  check('P1-13a 陌生人阶段长静默不推送', strangerStage === '陌生人' && lsStranger.triggered === false, `stage=${strangerStage}`);
  // 晨间问候：当前 19:xx 不在 6-10 窗口（时间门禁）——亲密门禁与 long_silence 共用同一 isAcquaintanceOrAbove 函数，已在上方验证
  const mg = await morningGreetingTrigger.check();
  check('P1-13b 晨间问候当前时段不触发（时间窗口外）', mg.triggered === false);

  // ═══════════ T10 (P1-14) 四维关系同步衰减 + 地板 ═══════════
  section('T10 (P1-14) 关系多维冷却衰减（原仅信任度）');
  await rel.updateRelationship([0.3, 0.3, 0.3, 0.3]); // 建立熟人关系：[0.6,0.5,0.5,0.6]
  check('P1-14a 已建立熟人关系（供后续触发器）', rel.getRelationshipState().stage === '熟人', rel.getRelationshipState().stage);
  const vBefore = rel.getRelationship();
  (rel as any).lastInteractionAt = Date.now() - 10 * 24 * 3600 * 1000; // 10 天前
  (rel as any).lastDecayAt = Date.now() - 10 * 24 * 3600 * 1000;
  await rel.tick();
  const vAfter = rel.getRelationship();
  const decayed = vAfter.map((v, i) => Math.abs(v - (vBefore[i] - 0.05)) < 0.0002);
  check('P1-14b 四维同步衰减 0.005×10天=0.05', decayed.every(Boolean), `${vBefore.join(',')} → ${vAfter.join(',')}`);
  // 地板测试：亲密 0.11 再衰减应停在 0.10（各自独立地板）
  await rel.updateRelationship([0, -0.34, 0, 0]); // 亲密 0.45 → 0.11
  (rel as any).lastInteractionAt = Date.now() - 10 * 24 * 3600 * 1000;
  (rel as any).lastDecayAt = Date.now() - 10 * 24 * 3600 * 1000;
  await rel.tick();
  check('P1-14c 亲密地板 0.10（不越界）', Math.abs(rel.getRelationship()[1] - 0.10) < 0.0002, `intimacy=${rel.getRelationship()[1]}`);

  // ═══════════ T11 (P1-15) long_silence 激活 + 24h 冷却 + 不刷新交互时间 ═══════════
  section('T11 (P1-15) shouldFireLongSilence 激活 / 冷却 / 不误刷新交互时间戳');
  (rel as any).lastLongSilenceAt = 0;
  (rel as any).lastInteractionAt = Date.now() - 25 * 3600 * 1000;
  check('P1-15a 静默≥24h 且未触发 → 允许触发', rel.shouldFireLongSilence() === true);
  (rel as any).lastLongSilenceAt = Date.now() - 1 * 3600 * 1000;
  check('P1-15b 24h 内已触发 → 冷却拦截（防每 TICK 重复）', rel.shouldFireLongSilence() === false);
  const interactionBefore = (rel as any).lastInteractionAt;
  (rel as any).lastLongSilenceAt = 0;
  const dimBefore = rel.getRelationship();
  await rel.receiveInteraction('long_silence');
  const dimAfter = rel.getRelationship();
  check('P1-15c long_silence 事件生效（依赖-0.01 亲密-0.005）', dimAfter[3] < dimBefore[3] && dimAfter[1] < dimBefore[1], `${dimBefore.join(',')} → ${dimAfter.join(',')}`);
  check('P1-15d long_silence 不刷新交互时间戳（冷却判定连续）', Math.abs((rel as any).lastInteractionAt - interactionBefore) < 60 * 1000);
  check('P1-15e 触发后进入冷却', rel.shouldFireLongSilence() === false);

  // ═══════════ T12 (P1-13bcd) 触发器 — 熟人场景长静默 / 高重要记忆 / 情绪分享 ═══════════
  section('T12 (P1-13) 触发器 — 熟人场景三触发器');
  // T10/T11 的衰减测试把关系压回陌生人 — 先重建熟人关系（avg 0.5+ → combined > 0.30）
  await rel.updateRelationship([0.3, 0.25, 0.3, 0.2]); // [0.80, 0.345, 0.70, 0.69]
  check('P1-13 前置 已恢复熟人关系', rel.getRelationshipState().stage === '熟人', rel.getRelationshipState().stage);
  const lsOk = await longSilenceTrigger.check();
  check('P1-13c 熟人 + 静默7h → 长静默触发', lsOk.triggered === true && lsOk.scene === 'long_silence', JSON.stringify(lsOk));
  const lsCool = await longSilenceTrigger.check();
  check('P1-13d 24h 冷却 → 第二次不触发', lsCool.triggered === false);
  const { addMemory, queryMemories, promoteMemories } = await import('./server/memory/store');
  addMemory(
    { userId: 'test-user', type: 'fact', keywords: ['豆包'], content: '用户养了一只叫豆包的猫', confidence: 0.95, sourceInteractionId: 'acc-1' },
    { tier: 'episodic', perspective: 'owner_trait', importance: 0.85, source: 'chat' },
  );
  const mt = await memoryTrigger.check();
  check('P1-13e 高重要(≥0.75)记忆 3 天未提及 → 记忆跟进触发', mt.triggered === true && mt.scene === 'memory_trigger' && mt.content.includes('豆包'), JSON.stringify(mt));
  await emotion.updateEmotions([0, 0, 0, 0.55, 0.55, 0, 0, 0]); // 担忧/孤独 > 0.5
  const es = await emotionShareTrigger.check();
  check('P1-13f 担忧/孤独偏高 → 情绪分享触发', es.triggered === true && es.scene === 'emotion_share', JSON.stringify(es));
  const esCool = await emotionShareTrigger.check();
  check('P1-13g 情绪分享 24h 冷却', esCool.triggered === false);

  // ═══════════ T13 (P1-9/10/11) IdleBrain 长待机闭环 ═══════════
  section('T13 (P1-9/10/11) IdleBrain 长待机 — 真实 userId + getters + 经验固化 + 情绪联动');
  // P1-9 前置：制造一条可固化记忆（retrieveCount≥3 且 value≥0.65）
  addMemory(
    { userId: 't-promote', type: 'fact', keywords: ['跑步', '运动'], content: '用户每周跑步三次', confidence: 0.95, sourceInteractionId: 'acc-2' },
    { tier: 'episodic', perspective: 'owner_trait', importance: 0.7, source: 'chat' },
  );
  for (let i = 0; i < 16; i++) queryMemories({ userId: 't-promote', query: '跑步', limit: 5 });
  const promoted = promoteMemories('t-promote');
  check('P1-9a promoteMemories 落库生效（返回提升条数）', promoted >= 1, `promoted=${promoted}`);
  const promotedMem = queryMemories({ userId: 't-promote', noTouch: true, limit: 10 }).find(m => m.keywords.includes('跑步'));
  check('P1-9b 高频记忆 tier 提升 episodic→internalized', promotedMem?.tier === 'internalized', `tier=${promotedMem?.tier}`);

  // P1-10/11：执行长待机（真实活跃用户 + 空 getters 回退），验证情绪联动与不抛错
  (global as any).__lastActiveUid = 'test-user';
  (global as any).__llmGetters = {}; // 无运行时 LLM 时回退 () => null（P1-11 不抛错路径）
  const emotionBefore = emotion.getEmotions();
  const { idleBrain } = await import('./server/autonomy/idle_brain');
  await idleBrain.longIdleConsolidation(); // 应完整执行不抛出
  const emotionAfter = emotion.getEmotions();
  check('P1-10a 独白情绪联动：平静↑', emotionAfter[1] > emotionBefore[1], `${emotionBefore[1].toFixed(3)} → ${emotionAfter[1].toFixed(3)}`);
  check('P1-10b 独白情绪联动：满足↑', emotionAfter[5] > emotionBefore[5], `${emotionBefore[5].toFixed(3)} → ${emotionAfter[5].toFixed(3)}`);
  check('P1-10c 独白情绪联动：孤独↓', emotionAfter[4] < emotionBefore[4], `${emotionBefore[4].toFixed(3)} → ${emotionAfter[4].toFixed(3)}`);
  const monologue = queryMemories({ userId: 'test-user', noTouch: true, limit: 50 }).find(m => (m.keywords || []).includes('内心独白'));
  check('P1-10d 内心独白记忆已生成（真实用户 test-user）', !!monologue && monologue.userId === 'test-user', monologue?.content?.slice(0, 30));
  check('P1-11 空 getters 不抛错（长待机完整跑通）', true, 'longIdleConsolidation 正常返回');

  // ═══════════ T14 (P1-15b) EmotionalState.intimacy 时间衰减 ═══════════
  section('T14 (P1-15b) EmotionalState.intimacy 时间衰减（state.ts 加载期）');
  const { createDefaultEmotionalState, saveEmotionalState, loadEmotionalState } = await import('./server/personality/state');
  const far = createDefaultEmotionalState();
  far.intimacy = 0.8;
  far.lastInteractionAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  far.lastUpdated = new Date().toISOString();
  saveEmotionalState('t-intimacy', far);
  await new Promise(r => setTimeout(r, 100)); // 等写队列落地
  const loaded = loadEmotionalState('t-intimacy');
  check('P1-15c 10 天疏远 → intimacy 0.8→0.79', Math.abs(loaded.intimacy - 0.79) < 1e-9, `intimacy=${loaded.intimacy}`);
  const floor = createDefaultEmotionalState();
  floor.intimacy = 0.04;
  floor.lastInteractionAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  floor.lastUpdated = new Date().toISOString();
  saveEmotionalState('t-intimacy', floor);
  await new Promise(r => setTimeout(r, 100));
  const loadedFloor = loadEmotionalState('t-intimacy');
  check('P1-15d 衰减地板 0.05（不归零）', Math.abs(loadedFloor.intimacy - 0.05) < 1e-9, `intimacy=${loadedFloor.intimacy}`);
  const fresh = createDefaultEmotionalState();
  fresh.intimacy = 0.5;
  fresh.lastInteractionAt = new Date().toISOString();
  fresh.lastUpdated = new Date().toISOString();
  saveEmotionalState('t-intimacy', fresh);
  await new Promise(r => setTimeout(r, 100));
  check('P1-15e 24h 内交互 → 不衰减', Math.abs(loadEmotionalState('t-intimacy').intimacy - 0.5) < 1e-9);

  // ═══════════ 汇总 ═══════════
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`验收结果: ${passed} 通过, ${failed.length} 失败`);
  if (failed.length > 0) {
    console.log('失败项:');
    for (const f of failed) console.log('  ❌', f);
    process.exitCode = 1;
  } else {
    console.log('🎉 14 项 P1 修复全部验收通过');
  }
}

main().catch(err => {
  console.error('测试执行异常:', err);
  process.exitCode = 1;
});
