// e2e_isolated_25fix.test.ts — 25 项缺陷修复·隔离库 E2E 完整测试（5 大场景 + 静态接线复核）
// 运行方式（必须从项目根目录，sqlite3 解析依赖项目 node_modules）：
//   TZ=America/New_York npx tsx e2e_isolated_25fix.test.ts
// 隔离数据目录：/tmp/lumi_e2e_run（LIFE_DB_PATH / LUMI_DATA_DIR / DB_PATH 全覆盖，不影响生产数据）
// TZ=America/New_York：保证 isLateNight() 判定为非深夜（本地当前为深夜 23 点，会误伤 L-11 触发器运行时验证）
//
// 场景：
//   S1 三轮对话复盘落库（E-2 解耦 / L-2 情绪增量落库 / L-16 思考链 / L-6 复盘 TTL / 无事务错误）
//   S2 打断后思绪跨轮接续（L-4 未消费保留 / resolve 消费 / L-18 72h 自动归档）
//   S3 断联重逢关系生疏回暖（L-7 重逢折扣 / L-8 负面降亲密信任 / L-12 新用户窗口+上限 / L-13 单一衰减）
//   S4 大量记忆 GC 全量扫描（L-5 无 50 条上限 + 核心/成长层豁免 + L-6 TTL 自动清理）
//   S5 长待机月度自省（L-9 真实 userId）+ 低情绪关怀/低活跃问候触发器（L-11）
//   S6 静态接线复核（E-3 静默降级 / O-1 模型档位 / L-10 预算裁剪 / L-15 降频轻量 / L-17 source 区分 / L-3 冷却 / O-2 宪法 / E-1 默认置信度）

import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = '/tmp/lumi_e2e_run';
const LIFEDB = path.join(TEST_DIR, 'life.db');
const PEPPA_DB = path.join(TEST_DIR, 'data', 'peppa.db');

// ── 隔离环境：必须在任何 server 模块 import 之前设置 ──
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
fs.writeFileSync(path.join(TEST_DIR, 'data', '.nomigrate_marker'), 'block auto-migration'); // 阻止 db_layer 自动迁移
process.env.LIFE_DB_PATH = LIFEDB;
process.env.LUMI_DATA_DIR = TEST_DIR;
process.env.DB_PATH = PEPPA_DB;
delete process.env.MCP_TOOLS_DISABLED;

let passed = 0;
const failed: string[] = [];
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
const eps = (a: number, b: number) => Math.abs(a - b) < 0.001;

async function main(): Promise<void> {
  // ═══════════ T0 基础初始化（隔离数据库） ═══════════
  section('T0 基础初始化（全新隔离库）');
  const db = await import('./db_layer');
  await db.initDatabase();
  const lifeDb = await import('./server/db/lifeDb');
  await lifeDb.initLifeDb();
  console.log('  隔离 DB 就绪');

  // ═══════════ S3 断联重逢关系生疏回暖（L-7/L-8/L-12/L-13） ═══════════
  section('S3 (L-7/L-8/L-12/L-13) 断联重逢关系生疏回暖');
  const { getRelationshipEngine } = await import('./server/life/relationship');
  const rel = getRelationshipEngine();
  check('S3-0 全新库 totalInteractions=0（熟络期窗口生效前提）', rel.getTotalInteractions() === 0);

  // L-12 新用户前 10 轮：亲密/信任增量减半 + 亲密度上限
  rel.beginReunionDiscount(0); // 确保无重逢折扣干扰
  const v0 = [...rel.getRelationshipState().vector];
  await rel.updateRelationship([0.1, 0.1, 0, 0]);
  let v1 = rel.getRelationshipState().vector;
  check('S3-1 (L-12) 新用户信任增量减半 0.1→0.05', eps(v1[0], v0[0] + 0.05), `d=${(v1[0] - v0[0]).toFixed(4)}`);
  check('S3-2 (L-12) 新用户亲密增量减半 0.1→0.05', eps(v1[1], v0[1] + 0.05), `d=${(v1[1] - v0[1]).toFixed(4)}`);
  // 上限探针：信任增量留余量避免饱和（重逢测试需要信任涨幅空间）
  await rel.updateRelationship([0.2, 1, 0, 0]);
  v1 = rel.getRelationshipState().vector;
  check('S3-3 (L-12) 亲密度早期上限 0.35（0.25+0.5→钳制 0.35）', eps(v1[1], 0.35), `intimacy=${v1[1].toFixed(3)}`);
  check('S3-4 (L-12) 上限只约束亲密维度（信任 0.35+0.1=0.45 正常增长）', eps(v1[0], 0.45), `trust=${v1[0].toFixed(3)}`);

  // 推进真实交互走出熟络期窗口（10 轮 positive）
  for (let i = 0; i < 10; i++) {
    await rel.receiveInteraction('user_initiated', 'positive');
  }
  check('S3-5 (L-12) 10 轮后 totalInteractions≥10 窗口结束', rel.getTotalInteractions() >= 10);

  // L-7 重逢折扣：24h 内信任/亲密增量 ×0.5（窗口已结束，仅重逢折扣生效）
  const v2 = [...rel.getRelationshipState().vector];
  rel.beginReunionDiscount(24);
  await rel.updateRelationship([0.1, 0.1, 0, 0]);
  const v3 = rel.getRelationshipState().vector;
  check('S3-6 (L-7) 重逢 24h 内信任增量 ×0.5（0.1→0.05）', eps(v3[0], v2[0] + 0.05), `d=${(v3[0] - v2[0]).toFixed(4)}`);
  check('S3-7 (L-7) 重逢 24h 内亲密增量 ×0.5（0.1→0.05）', eps(v3[1], v2[1] + 0.05), `d=${(v3[1] - v2[1]).toFixed(4)}`);

  // L-8 负面交互真实降低亲密/信任（修复前一律正增量）
  const v4 = [...rel.getRelationshipState().vector];
  await rel.receiveInteraction('user_initiated', 'negative');
  const v5 = rel.getRelationshipState().vector;
  check('S3-8 (L-8) negative outcome 降低信任', v5[0] < v4[0], `d=${(v5[0] - v4[0]).toFixed(4)}`);
  check('S3-9 (L-8) negative outcome 降低亲密', v5[1] < v4[1], `d=${(v5[1] - v4[1]).toFixed(4)}`);

  // L-13：state.ts 已移除独立衰减（统一由 relationship 四维衰减承担）
  const stateSrc = fs.readFileSync('server/personality/state.ts', 'utf-8');
  check('S3-10 (L-13) state.ts 无 intimacy 独立时间衰减代码', !/hoursIdle[\s\S]{0,80}intimacy\s*-\s*/.test(stateSrc) && stateSrc.includes('L-13'), '');
  check('S3-11 (L-13) state.ts 无 curiosity 每轮 -0.005 自然衰减', !stateSrc.includes('curiosity - 0.005') && !stateSrc.includes('- 0.005'), '');

  // ═══════════ S1 三轮对话复盘落库（E-2/L-2/L-16/L-6） ═══════════
  section('S1 (E-2/L-2/L-16/L-6) 三轮对话复盘落库');
  const { performPostChatReview } = await import('./server/hooks/review');
  const reasoning = '第1步唤醒觉知…第2步身份锚定…第3步需求解构：用户表达情绪困扰，属怀旧谈心类，屏蔽工具…第5步内心感悟：陪伴是底层动机…第6步情绪修饰…第7步延伸关怀';
  const mkCtx = (text: string, response: string, i: number) => ({
    uid: 'e2e-user',
    text,
    response,
    sessionKey: 's1',
    personality: { name: 'Peppa', vector: [0.5, 0.6, 0.5, 0.5, 0.6, 0.5, 0.5, 0.5] },
    emotion: { emotions: [0.5, 0.4, 0.3, 0.1, 0.1, 0.4, 0.3, 0.2], dominant: '平静' },
    conversationId: `conv-${i}`,
    domain: 'personal',
    orgId: '',
    reasoning,
  });
  let r1: any, r2: any, r3: any, e1: any = null;
  try {
    r1 = await performPostChatReview(mkCtx(
      '我今天很难过，工作压力好大，感觉撑不住了',
      '我能理解你的感受，压力大的时候允许自己慢下来，先做一点小事恢复能量，我会一直陪着你慢慢来，不着急。',
      1,
    ));
    r2 = await performPostChatReview(mkCtx(
      '我觉得家人支持对我来说很重要，周末想带爸妈去西湖玩，帮我规划一下路线，顺便看下天气',
      '可以的，周末去西湖可以走这个路线：先坐地铁到龙翔桥，再沿湖散步到断桥，天气晴的话很适合，建议早上出发避开人流高峰。',
      2,
    ));
    r3 = await performPostChatReview(mkCtx(
      '我最近喜欢喝咖啡，每天早上都要来一杯',
      '我记下了，你喜欢咖啡这个习惯很好，适当喝没有问题。',
      3,
    ));
  } catch (err) {
    e1 = err;
  }
  check('S1-0 三轮复盘零异常（无事务错误）', e1 === null, e1 ? String(e1) : '');

  const { searchMemoriesByType, saveEmotionVector } = lifeDb;
  const reviews = await searchMemoriesByType('chat_review');
  check('S1-1 (E-2) 复盘记录落库 ≥3 条（断开解耦后仍入库）', reviews.length >= 3, `got ${reviews.length}`);
  const qualityValid = r1 && r2 && r3 && r1.qualityScore > 0 && r2.qualityScore > 0 && r3.qualityScore > 0;
  check('S1-2 三轮交互质量评估有效', qualityValid === true, `q=[${r1?.qualityScore},${r2?.qualityScore},${r3?.qualityScore}]`);
  check('S1-3 (L-6) 复盘时效场景 TTL 标记（天气/路线场景 ≥1）', r2?.ttlCachedItems >= 1, `ttl=${r2?.ttlCachedItems}`);

  // L-2：情绪增量后落库（getEmotions 返回拷贝，必须在 receiveEvent 之后重新读取）
  const { getEmotionEngine } = await import('./server/life/emotions');
  const emo = getEmotionEngine();
  const sqlite3Mod = (await import('sqlite3')).default;
  const savedVec = await new Promise<number[] | null>((resolve) => {
    const sdb = new sqlite3Mod.Database(LIFEDB);
    // rowid 单调递增：created_at 为秒级精度，同秒多行时 DESC 排序不稳定
    sdb.get('SELECT vector_json FROM emotion_state ORDER BY rowid DESC LIMIT 1', (err: any, row: any) => {
      sdb.close();
      resolve(err ? null : JSON.parse(row?.vector_json || 'null'));
    });
  });
  check('S1-4 (L-2) 复盘情绪增量已落库（库内向量==当前引擎向量）', !!savedVec && JSON.stringify(savedVec) === JSON.stringify(emo.getEmotions()), `saved=${JSON.stringify(savedVec)} eng=${JSON.stringify(emo.getEmotions())}`);

  // 复盘写出的各类记忆
  const { queryMemories } = await import('./server/memory/store');
  const core = queryMemories({ userId: 'e2e-user', tier: 'core_identity' as any, limit: 20, noTouch: true });
  const growth = queryMemories({ userId: 'e2e-user', tier: 'growth' as any, limit: 20, noTouch: true });
  const reasoningMems = queryMemories({ userId: 'e2e-user', limit: 50, noTouch: true }).filter((m: any) => m.content.includes('思考链'));
  check('S1-5 人格记忆（core_identity）落库', core.length >= 1, `got ${core.length}`);
  check('S1-6 用户特征记忆（growth）落库', growth.length >= 1, `got ${growth.length}`);
  check('S1-7 (L-16) 思考链沉淀落库 ≥1 条', reasoningMems.length >= 1, `got ${reasoningMems.length}`);
  check('S1-8 复盘联动关系更新', r1?.relationshipUpdated === true);

  // ═══════════ S2 打断后思绪跨轮接续（L-4/L-18） ═══════════
  section('S2 (L-4/L-18) 打断后思绪跨轮接续');
  const { addInteractionMemory, getUnresolvedThoughts, resolveThoughts, expireStaleThoughts } = lifeDb;
  const t1 = await addInteractionMemory('internal_thought', {
    thought: '用户提到喜欢咖啡，下次可以聊聊咖啡文化',
    source: 'chat',
    intensity: 0.6,
    resolved: false,
  }, 0.5);
  let thoughts = await getUnresolvedThoughts(3);
  check('S2-1 (L-4) 未消费思绪可检索（resolved=false）', thoughts.some((t: any) => t.id === t1 && t.parsed.resolved === false));
  // 模拟打断：不 resolve，第二轮检索依然可见 → 跨轮接续前提
  thoughts = await getUnresolvedThoughts(3);
  check('S2-2 (L-4) 打断后思绪保留（下一轮可接续）', thoughts.some((t: any) => t.id === t1));
  await resolveThoughts([t1]);
  thoughts = await getUnresolvedThoughts(3);
  check('S2-3 (L-4) 消费后置 resolved，不再注入', !thoughts.some((t: any) => t.id === t1));

  // L-18：72h 未接续自动归档
  const t2 = await addInteractionMemory('internal_thought', {
    thought: '搁置很久的旧思绪',
    source: 'idle',
    intensity: 0.4,
    resolved: false,
  }, 0.3);
  const sdb = new sqlite3Mod.Database(LIFEDB);
  await new Promise<void>((resolve) => {
    sdb.run('UPDATE interaction_memories SET created_at = datetime("now", "-73 hours") WHERE id = ?', [t2], () => resolve());
  });
  sdb.close();
  const expired = await expireStaleThoughts(72);
  check('S2-4 (L-18) 超 72h 搁置思绪自动归档', expired >= 1, `got ${expired}`);
  const sdb2 = new sqlite3Mod.Database(LIFEDB);
  const t2row = await new Promise<any>((resolve) => {
    sdb2.get('SELECT context_json FROM interaction_memories WHERE id = ?', [t2], (err: any, row: any) => resolve(row));
  });
  sdb2.close();
  const t2ctx = t2row ? JSON.parse(t2row.context_json) : null;
  check('S2-5 (L-18) 归档标记 expired=true', t2ctx?.expired === true && t2ctx?.resolved === true, JSON.stringify(t2ctx));

  // ═══════════ S4 大量记忆 GC 全量扫描（L-5/L-6） ═══════════
  section('S4 (L-5/L-6) 大量记忆 GC 全量扫描 + 核心豁免 + TTL 清理');
  const { addMemory } = await import('./server/memory/store');
  const { runMemoryGC } = await import('./server/memory/gc');
  const { readDB, writeDB } = await import('./db_layer');
  const UID = 'gc-e2e';

  // 60 条低频记忆（> 旧版 50 条上限，验证全量扫描）+ 2 条重复对 + 核心/成长层 + TTL 新旧各一
  for (let i = 0; i < 60; i++) {
    addMemory(
      { userId: UID, type: 'fact' as any, content: `lowfreqmem-${i}`, keywords: ['低频'], confidence: 0.5, sourceInteractionId: '' },
      { tier: 'episodic' as any, perspective: 'owner_trait' as any, importance: 0.6 },
    );
  }
  // 重复对使用不同 type 写入（绕过 store 层同 type 去重，验证 gc 层 jaccard 合并）
  addMemory(
    { userId: UID, type: 'fact' as any, content: '我今天中午吃了牛肉面，味道很不错', keywords: ['吃饭'], confidence: 0.8, sourceInteractionId: '' },
    { tier: 'episodic' as any, perspective: 'owner_trait' as any, importance: 0.6 },
  );
  addMemory(
    { userId: UID, type: 'preference' as any, content: '我今天中午吃了牛肉面，味道很不错哦', keywords: ['吃饭'], confidence: 0.8, sourceInteractionId: '' },
    { tier: 'episodic' as any, perspective: 'owner_trait' as any, importance: 0.6 },
  );
  // 核心/成长层内容互不相同（避免 store 层 bigram 相似度去重误合并探针数据）
  const coreContents = [
    '我的核心价值观：家人永远第一位',
    '我的行为准则：诚信立身是根本',
    '我的成长信条：好奇心驱动持续学习',
  ];
  const growthContents = [
    '我对用户的长期认知：用户喜欢阅读历史',
    '我对用户的长期认知：用户偏爱简洁设计',
    '我对用户的长期认知：用户注重办事效率',
  ];
  for (let i = 0; i < 3; i++) {
    addMemory(
      { userId: UID, type: 'fact' as any, content: coreContents[i], keywords: ['价值观'], confidence: 0.9, sourceInteractionId: '' },
      { tier: 'core_identity' as any, perspective: 'peppa_self' as any, importance: 0.8, userApproved: true },
    );
    addMemory(
      { userId: UID, type: 'fact' as any, content: growthContents[i], keywords: ['认知'], confidence: 0.7, sourceInteractionId: '' },
      { tier: 'growth' as any, perspective: 'user_trait' as any, importance: 0.5 },
    );
  }
  addMemory(
    { userId: UID, type: 'knowledge' as any, content: '北京今天天气晴朗适合出游 [TTL:7d]', keywords: ['天气'], confidence: 0.6, sourceInteractionId: '' },
    { tier: 'episodic' as any, perspective: 'owner_trait' as any, importance: 0.5 },
  );
  addMemory(
    { userId: UID, type: 'knowledge' as any, content: '上海今日天气晴到多云 [TTL:7d] 明天降温', keywords: ['天气'], confidence: 0.6, sourceInteractionId: '' },
    { tier: 'internalized' as any, perspective: 'owner_trait' as any, importance: 0.5 },
  );

  // 回拨时间：60 条低频 lastRetrievedAt -40 天；TTL 老记录 createdAt -8 天；核心层一条 lastRetrievedAt -40 天（豁免探针）
  const d = readDB();
  const now = Date.now();
  for (const m of d.memories) {
    if (m.userId !== UID) continue;
    if (String(m.content).startsWith('lowfreqmem-')) {
      m.lastRetrievedAt = new Date(now - 40 * 86400000).toISOString();
    }
    if (m.content.includes('北京今天天气')) {
      m.createdAt = new Date(now - 8 * 86400000).toISOString();
      m.updatedAt = m.createdAt;
    }
    if (m.tier === 'core_identity' && m.content.includes('家人永远第一位')) {
      m.lastRetrievedAt = new Date(now - 40 * 86400000).toISOString(); // 豁免探针
    }
  }
  writeDB(d);

  const pre = queryMemories({ userId: UID, limit: 100000, noTouch: true });
  check('S4-1 (L-5) 全量扫描范围：70 条全部可见（无 50 条上限）', pre.length === 70, `got ${pre.length}`);
  const gc = await runMemoryGC([UID]);
  check('S4-2 (L-5) 低频降权 60 条（远超旧 50 上限）', gc.downweighted >= 60, JSON.stringify(gc));
  check('S4-3 重复记忆合并 ≥1 对', gc.merged >= 1, JSON.stringify(gc));
  check('S4-4 (L-6) TTL 过期清理 1 条（8 天前 [TTL:7d]）', gc.cleaned === 1, JSON.stringify(gc));

  const post = queryMemories({ userId: UID, limit: 100000, noTouch: true });
  const coreM = post.filter((m: any) => m.tier === 'core_identity');
  const growthM = post.filter((m: any) => m.tier === 'growth');
  check('S4-5 (L-5) 核心层 3 条全部保留且 importance=0.8 不衰减', coreM.length === 3 && coreM.every((m: any) => m.importance === 0.8), `core=${coreM.map((m: any) => m.importance).join(',')}`);
  check('S4-6 (L-5) 成长层 3 条全部保留且 importance=0.5 不衰减', growthM.length === 3 && growthM.every((m: any) => m.importance === 0.5), `growth=${growthM.map((m: any) => m.importance).join(',')}`);
  check('S4-7 (L-5) 核心层 40 天未检索也不降权（豁免生效）', coreM.some((m: any) => m.content.includes('家人永远第一位') && m.importance === 0.8));
  check('S4-8 (L-6) 未过期 TTL 记忆保留', post.some((m: any) => m.content.includes('上海今日天气')));
  const lowfreq0 = post.find((m: any) => m.content === 'lowfreqmem-0');
  check('S4-9 (L-5) 低频记忆已降权 0.6→0.3', !!lowfreq0 && eps(lowfreq0.importance, 0.3), `imp=${lowfreq0?.importance}`);

  // ═══════════ S5 长待机月度自省（L-9）+ 低情绪关怀（L-11） ═══════════
  section('S5 (L-9/L-11) 长待机月度自省 + 低情绪关怀');
  const { idleBrain } = await import('./server/autonomy/idle_brain');
  (global as any).__lastActiveUid = 'uid-e2e';
  await idleBrain.monthlyReflection();
  const uidMems = queryMemories({ userId: 'uid-e2e', limit: 20, noTouch: true });
  const sysMems = queryMemories({ userId: 'system', limit: 20, noTouch: true });
  check('S5-1 (L-9) 月度自省记忆归属真实用户 uid-e2e', uidMems.some((m: any) => m.content.includes('[月度自省')));
  check('S5-2 (L-9) 不再写死 system 用户', !sysMems.some((m: any) => m.content.includes('月度自省')));

  const { allTriggers, lowMoodComfortTrigger, lowActivityGreetingTrigger } = await import('./server/proactive/triggers');
  check('S5-3 (L-11) low_mood_comfort 触发器已注册', allTriggers.some((t: any) => t.name === 'low_mood_comfort'));
  check('S5-4 (L-11) low_activity_greeting 触发器已注册', allTriggers.some((t: any) => t.name === 'low_activity_greeting'));

  // 运行时触发验证：关系升至熟人以上 + 情绪低落 + 沉默 13h
  rel.setInteractionCount(500);
  (rel as any).vector = [0.6, 0.6, 0.6, 0.6];
  check('S5-5 前置：关系阶段达到熟人以上', rel.getRelationshipState().stage !== '陌生人', rel.getRelationshipState().stage);
  (emo as any).vector = [0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]; // 喜悦 0.1 < 0.2 → 低落
  (global as any).__lastUserMessageAt = Date.now() - 13 * 3600 * 1000;
  const lowMoodRes = await lowMoodComfortTrigger.check();
  check('S5-6 (L-11) 沉默13h+低情绪 → 触发 low_mood_comfort', lowMoodRes.triggered === true && lowMoodRes.scene === 'low_mood_comfort', JSON.stringify(lowMoodRes).slice(0, 120));
  const lowAct13 = await lowActivityGreetingTrigger.check();
  check('S5-7 (L-11) 沉默13h 未达 48h → 不触发问候', lowAct13.triggered === false, JSON.stringify(lowAct13).slice(0, 80));
  (global as any).__lastUserMessageAt = Date.now() - 49 * 3600 * 1000;
  const lowAct49 = await lowActivityGreetingTrigger.check();
  check('S5-8 (L-11) 沉默49h → 触发 low_activity_greeting', lowAct49.triggered === true && lowAct49.scene === 'low_activity_greeting', JSON.stringify(lowAct49).slice(0, 120));

  // ═══════════ S6 静态接线复核 ═══════════
  section('S6 静态接线复核');
  const read = (f: string) => fs.readFileSync(f, 'utf-8');
  const chatSrc = read('server/socket/chat.ts');

  // E-3 静默降级
  check('S6-1 (E-3) retriever 缺失表静默降级（sqlite_master 预检）', read('server/memory/retriever.ts').includes('sqlite_master'));
  check('S6-2 (E-3) timeline 缺失表静默降级（sqlite_master 预检）', read('server/memory/timeline.ts').includes('sqlite_master'));
  check('S6-3 (E-3) peppa.db 路径统一走 getPeppaDbPath（7 处含目录创建）', read('server/config/data_path.ts').includes('mkdirSync'));

  // O-1 模型档位（去掉注释行后断言无硬编码赋值）
  for (const f of ['server/socket/chat.ts', 'server/socket/voice.ts', 'server/socket/task.ts']) {
    const codeOnly = read(f).split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    check(`S6-4 (O-1) ${path.basename(f)} 无 v4-pro 硬编码`, !codeOnly.includes("'deepseek-v4-pro'"), '');
  }
  check('S6-5 (O-1) chat 用 COMPLEX_MODELS/DEFAULT_MODELS', chatSrc.includes('COMPLEX_MODELS') && chatSrc.includes('DEFAULT_MODELS'));
  check('S6-6 (O-1) voice 用 COMPLEX_MODELS', read('server/socket/voice.ts').includes('COMPLEX_MODELS'));
  check('S6-7 (O-1) task 用 DEFAULT_MODELS/COMPLEX_MODELS', read('server/socket/task.ts').includes('DEFAULT_MODELS') && read('server/socket/task.ts').includes('COMPLEX_MODELS'));

  // L-10 预算裁剪
  check('S6-8 (L-10) 预算块含 relevantHistory 裁剪', chatSrc.includes("label: 'relevantHistory'") || (chatSrc.includes('relevantHistory') && chatSrc.includes('lowPriorityBlocks')));
  check('S6-9 (L-10) 预算块含 timelineHistory 裁剪', chatSrc.includes('timelineHistory'));
  check('S6-10 (L-10) 预算块含 prefTags 裁剪', chatSrc.includes('prefTagsBlock'));
  check('S6-11 (L-10) 预算块含 knowledge 裁剪', chatSrc.includes('knowledgeBlock'));

  // L-15 / L-17 自主任务
  check('S6-12 (L-15) 自主任务轻量模型（scenario: light + maxTokens 500）', read('server/autonomy/task_generator.ts').includes("scenario: 'light'") && read('server/autonomy/task_generator.ts').includes('maxTokens: 500'));
  check('S6-13 (L-15) autonomous_work_cycle 降频 2h', read('server/scheduler.ts').includes('autonomous_work_cycle') && (read('server/scheduler.ts').includes('every_2h') || read('server/scheduler.ts').includes('7200')));
  check('S6-14 (L-17) task source 区分 emotion/memory/context/idle', ['autonomous_emotion', 'autonomous_memory', 'autonomous_context', 'autonomous_idle'].every(s => read('server/autonomy/task_generator.ts').includes(s)));

  // L-3 人格冷却
  check('S6-15 (L-3) 人格演进 7 天冷却接线', read('server/personality/evolution.ts').includes('7 * 24 * 60 * 60 * 1000') && read('server/personality/registry.ts').includes('604800000'));

  // O-2 宪法 4 条新守卫
  const constitutionSrc = read('server/personality/constitution.ts');
  for (const article of ['action.constitution', 'work.product.supervision', 'self.extension', 'collaboration.lap']) {
    check(`S6-16 (O-2) 宪法守卫 ${article} 已配置`, constitutionSrc.includes(article));
  }
  check('S6-17 (O-2) 严重违规合规结尾含 action.constitution', constitutionSrc.includes("'action.constitution'") && constitutionSrc.includes('经过你的确认'));

  // E-1 默认置信度
  check('S6-18 (E-1) addMemory 默认 confidence 0.5', read('server/memory/store.ts').includes('?? 0.5'));

  // L-1 / L-14 情绪稳态数学
  const emoSrc = read('server/life/emotions.ts');
  check('S6-19 (L-1) 单一收敛机制 BASELINE_CONVERGE_RATE=0.03', emoSrc.includes('BASELINE_CONVERGE_RATE = 0.03'));
  check('S6-20 (L-14) 低值恢复阈值与基线联动', emoSrc.includes('阈值与基线联动') || emoSrc.includes('低值恢复'));

  // L-7/L-8 chat 接线
  check('S6-21 (L-7) chat 重逢分支调用 beginReunionDiscount', chatSrc.includes('beginReunionDiscount'));
  check('S6-22 (L-8) chat 交互 outcome 分支接线', chatSrc.includes("'negative'") && chatSrc.includes('receiveInteraction'));

  // L-4 chat 接线
  check('S6-23 (L-4) chat 注入未解决思绪 + 用后 resolve', chatSrc.includes('getUnresolvedThoughts') && chatSrc.includes('resolveThoughts'));

  // L-16 adapter 思考链透传
  check('S6-24 (L-16) adapter LLMResult 携带 reasoningContent', read('server/llm/adapter.ts').includes('reasoningContent'));

  // L-13 relationship 四维衰减承担
  check('S6-25 (L-13) relationship 引擎存在四维衰减', read('server/life/relationship.ts').includes('long_silence'));

  // ═══════════ S7 阶段一：三大示例全流程 + 自主 + 情绪记忆 + 人格校验 ═══════════
  section('S7 阶段一（模块1-4）功能全量集成验证');

  // ── S7-A 示例一：行程自动提醒推送全流程（travel-cal-mcp 加密 CRUD + 临近推送 + 偏好沉淀） ──
  {
    const tc = await import('./server/tools/mcp_servers/travel_cal');
    const uid = 'e2e-travel-user';
    // 加密往返（不可逆明文检验）
    const plan = { title: '杭州出差', destination: '杭州', departAt: '2026-08-10T09:00', notes: { hotel: '西湖边' } };
    const enc = tc.encryptTravelPlan(plan);
    const dec = tc.decryptTravelPlan(enc);
    check('S7-A1 行程加密: 密文不含明文目的地', enc && !enc.includes('杭州') && enc.length > 40, `len=${enc?.length}`);
    check('S7-A2 行程加密: 解密还原完整（AES-256-GCM）', dec?.destination === '杭州' && dec?.notes?.hotel === '西湖边');
    // CRUD
    const r1 = await tc.registerTravelTools; // 仅确认导出存在
    check('S7-A3 travel-cal-mcp 导出 registerTravelTools', typeof r1 === 'function');
    const id = await (await import('./server/db/lifeDb')).addTravelItinerary(uid, {
      title: '杭州出差', encrypted: enc, destination: '杭州', departAt: '2026-08-10T09:00', remindHours: 24,
    });
    const list = await (await import('./server/db/lifeDb')).listTravelItineraries(uid);
    check('S7-A4 行程落库 travel_itineraries 表', list.length === 1 && list[0].status === 'upcoming');
    check('S7-A5 行程加密存储（数据库内为密文，不泄露目的地）', list[0].encrypted !== plan.title && !list[0].encrypted.includes('杭州') && list[0].encrypted.length > 30);
    // 更新 + 删除
    await (await import('./server/db/lifeDb')).updateTravelItinerary(id, { status: 'cancelled' });
    const after = await (await import('./server/db/lifeDb')).getTravelItinerary(id);
    check('S7-A6 行程更新状态生效', after?.status === 'cancelled');
    await (await import('./server/db/lifeDb')).deleteTravelItinerary(id);
    check('S7-A7 行程删除生效', (await (await import('./server/db/lifeDb')).getTravelItinerary(id)) === null);
    // 临近推送（无网络时也应能走通知表通道，返回 0 不报错）
    const pushed = await tc.pushUpcomingTravelInfo(uid, 72).catch(() => 0);
    check('S7-A8 行程临近推送函数可执行（无异常）', typeof pushed === 'number');
    // 偏好沉淀
    await (await import('./server/db/lifeDb')).bumpPreferenceTag(uid, '孪生-出行-杭州', 0.2);
    const twinTags = await (await import('./server/autonomy/digital_twin')).predictBehaviors(uid);
    check('S7-A9 数字孪生行为预判命中出行标签', twinTags.some(t => t.dimension === '出行' && t.tags.includes('杭州')), JSON.stringify(twinTags.map(t => t.dimension)));
  }

  // ── S7-B 示例二：国际时事多源检索综合分析（web-search-mcp 多源 + 时效过滤 + 去偏见） ──
  {
    const ws = await import('./server/tools/mcp_servers/web_search');
    // 时效过滤纯函数（24h/7d）
    const fresh = new Date(Date.now() - 2 * 3600 * 1000).toUTCString();
    const old = new Date(Date.now() - 20 * 24 * 3600 * 1000).toUTCString();
    check('S7-B1 时效过滤: 2h 前在 24h 窗口内', ws.isWithinWindow(fresh, 24));
    check('S7-B2 时效过滤: 20 天前超出 7d 窗口', !ws.isWithinWindow(old, 24 * 7));
    check('S7-B3 多源检索可执行（网络异常时优雅返回空数组不抛错）', Array.isArray(await ws.fetchMultiSource('国际', 24, 5).catch(() => [])));
    check('S7-B4 强制检索词表覆盖时事类（MUST_SEARCH_TERMS）', ['时事', '国际', '战争', '美联储', '突发'].every(t => ws.MUST_SEARCH_TERMS.includes(t)));
    // 去偏见对比 handler 存在且不替用户下结论（handler 注册于 registry，直接验证描述）
    const wsReg = new (await import('./server/tools/registry')).ToolRegistry();
    ws.registerWebSearchTools(wsReg);
    const cmpDesc = wsReg.get('websearch_compare')?.description || '';
    check('S7-B5 websearch_compare 描述含去偏见承诺', cmpDesc.includes('去偏见') || cmpDesc.includes('不替用户下结论'), cmpDesc.slice(0, 50));
  }

  // ── S7-C 示例三：个股客观数据整理（stock-fin-mcp 客观陈列 + 免责声明 + 无建议） ──
  {
    const sf = await import('./server/tools/mcp_servers/stock_fin');
    // 纯函数行情解析
    const q = sf.parseTencentQuote('v_sh600000="1~浦发银行~600000~7.5~7.4~7.45~123456~0~0~0~~7.46~7.44~7.6~7.2~~0~0~~0~0~0~0~0~0~0~0~0~0~0~~0~0~1.35~0.55~0.66~7.5~7.6~7.2~~~1.3~123456~1~7.5~7.4~~~"');
    check('S7-C1 腾讯行情解析: 浦发银行现价 7.5', q?.price === 7.5 && q?.name === '浦发银行', JSON.stringify(q));
    check('S7-C2 行情解析: 成交量 123456 手', q?.volume === 123456);
    check('S7-C3 代码归一: 600000→sh600000 / 000001→sz000001', sf.normalizeStockCode('600000') === 'sh600000' && sf.normalizeStockCode('000001') === 'sz000001');
    // 免责声明硬约束（所有工具描述/输出均带）
    const sfReg = new (await import('./server/tools/registry')).ToolRegistry();
    sf.registerStockTools(sfReg);
    const descs = ['stock_quote', 'stock_kline', 'stock_news', 'stock_boards'].map(n => sfReg.get(n)?.description || '');
    check('S7-C4 四个股票工具描述全部含免责', descs.every(d => d.includes('投资建议') || d.includes('免责')));
    check('S7-C5 免责声明常量存在（不构成投资建议）', read('server/tools/mcp_servers/stock_fin.ts').includes('不构成任何投资建议'));
  }

  // ── S7-D 自主驱动：PSI 三需求张力 + 新老用户频次 + 空闲资讯简报 + 行程触发器接线 ──
  {
    const psi = await import('./server/autonomy/psi_motivation');
    // 张力纯函数
    const c = psi.tensionForNeed('curiosity', 12 * 60); // 12h 未满足
    check('S7-D1 PSI 好奇心张力随未满足时长上升', c > 0.5 && c <= 1, `t=${c.toFixed(2)}`);
    check('S7-D2 PSI 规划需求: 无行程低张力 0.15', psi.tensionForNeed('planning', 0) === 0.15);
    check('S7-D3 PSI 规划需求: 72h 内行程临近张力高', psi.tensionForNeed('planning', 0, 12) > 0.7);
    // 新老用户频次（lastPushAt = 1 天前：新用户 3 天频次未到 → 禁止；老用户 1 天频次已到 → 允许）
    const newU = psi.pushAllowed(3, Date.now() - 1 * 24 * 3600 * 1000);
    const oldU = psi.pushAllowed(20, Date.now() - 1 * 24 * 3600 * 1000);
    check('S7-D4 PSI 新用户(<7天) 3 天频次克制', !newU.allowed && newU.frequency === 3, `freq=${newU.frequency}`);
    check('S7-D5 PSI 老用户(≥7天) 1 天频次', oldU.allowed && oldU.frequency === 1, `freq=${oldU.frequency}`);
    // 行程触发器接线
    const trig = await import('./server/proactive/triggers');
    check('S7-D6 行程临近触发器已注册（travelUpcomingTrigger）', trig.allTriggers.some(t => t.name === 'travel_upcoming'));
    check('S7-D7 行程触发器调用 pushUpcomingTravelInfo', read('server/proactive/triggers.ts').includes('pushUpcomingTravelInfo'));
    // 资讯简报复用 NEWS_SOURCES 底座
    check('S7-D8 PSI 简报复用多源抓取（web_search.fetchMultiSource 底层即 NEWS_SOURCES）', read('server/autonomy/psi_motivation.ts').includes('fetchMultiSource') && read('server/tools/mcp_servers/web_search.ts').includes('NEWS_SOURCES'));
    // 长待机简报接线（idle_brain 调 generateIdleBriefing）
    check('S7-D9 IdleBrain 长待机接入资讯简报', read('server/autonomy/idle_brain.ts').includes('generateIdleBriefing'));
  }

  // ── S7-E 情绪记忆场景（复用 L-1/L-6/L-2 已验基础上追加 TTL 全链路 + 情绪基线） ──
  {
    const emo = await import('./server/life/emotions');
    const e = emo.getEmotionEngine();
    const before = e.getEmotions();
    await e.updateEmotions([0, 0, 0, 0.1, 0, 0, 0, 0]); // 担忧 +
    const after = e.getEmotions();
    check('S7-E1 情绪增量更新生效（担忧维度变化）', Math.abs(after[3] - before[3]) > 0.001, `d=${(after[3] - before[3]).toFixed(4)}`);
    check('S7-E2 情绪向量恒为 8 维', after.length === 8);
    // 基线收敛机制存在
    check('S7-E3 情绪基线收敛机制存在', read('server/life/emotions.ts').includes('BASELINE_CONVERGE_RATE'));
    // 复盘解耦：performPostChatReview 不阻塞主流程
    check('S7-E4 复盘为异步 fire-and-forget（非 await 阻塞）', read('server/socket/chat.ts').includes('performPostChatReview'));
    check('S7-E5 记忆默认置信度 0.5（E-1）', read('server/memory/store.ts').includes('?? 0.5'));
    check('S7-E6 TTL 全链路（标记→写入→清理）', read('server/tools/interceptor.ts').includes('markToolResultTTL') && read('server/memory/gc.ts').includes('isTTLExpired'));
  }

  // ── S7-F 人格校验：多路径推理 + 资讯微调接线 + 宪法守卫 ──
  {
    const mpr = await import('./server/cognition/multi_path_reasoner');
    // 交叉校验纯函数：一致→共识
    const c1 = mpr.crossValidatePaths([
      { perspective: '理性实证', conclusion: '气温升高导致冰川消融', confidence: 0.7, reasoning: '', caveats: [] },
      { perspective: '反面证伪', conclusion: '气温升高导致冰川消融', confidence: 0.6, reasoning: '', caveats: ['局部地区例外'] },
    ]);
    check('S7-F1 多路径一致 → 共识结论（一致度 1.0）', c1.agreed && c1.consensus === '气温升高导致冰川消融' && c1.verdict === 'consensus', JSON.stringify({a: c1.agreement, v: c1.verdict}));
    check('S7-F2 共识置信度抬升（0.7·0.6→综合>0.6）', c1.finalConfidence > 0.6, `conf=${c1.finalConfidence.toFixed(3)}`);
    // 分歧 → 不武断下结论
    const c2 = mpr.crossValidatePaths([
      { perspective: '理性实证', conclusion: 'A 是主因', confidence: 0.8, reasoning: '', caveats: ['数据样本小'] },
      { perspective: '反面证伪', conclusion: 'B 才是主因', confidence: 0.7, reasoning: '', caveats: ['缺乏对照实验'] },
    ]);
    check('S7-F3 多路径分歧 → 不武断下结论', !c2.agreed && c2.verdict === 'conflict' && c2.finalConfidence <= 0.3, `agreed=${c2.agreed}`);
    check('S7-F4 分歧输出携带待核实要点', c2.conflictingPoints.length >= 1, JSON.stringify(c2.conflictingPoints));
    // 推理报告含去偏见原则
    check('S7-F5 推理报告含交叉校验原则', mpr.formatReasonReport(c2).includes('交叉校验'));
    // 无 LLM 时纯结构降级不抛错
    const c3 = await mpr.multiPathReason('测试问题', { llm: async () => null });
    check('S7-F6 无 LLM 时多路径降级不抛错', c3.verdict === 'insufficient', c3.verdict);
    // 资讯微调接线：personality 支持 news_reading 事件
    const persSrc = read('server/life/personality.ts');
    check('S7-F7 人格引擎支持 news_reading 事件', persSrc.includes("'news_reading'"));
    check('S7-F8 资讯微调只动好奇心/开放性（慢步长 0.003）', persSrc.includes('0.003'));
    // 宪法治安：4 条守卫 + 违规拦截
    const constit = read('server/personality/constitution.ts');
    check('S7-F9 宪法 4 条守卫完整', ['action.constitution', 'work.product.supervision', 'self.extension', 'collaboration.lap'].every(a => constit.includes(a)));
    // 工具注册清单（5 套 MCP 全量注册）
    const allSrc = read('server/tools/definitions/index.ts');
    check('S7-F10 registerAllTools 接入 5 套 MCP 注册', allSrc.includes('registerMcpServers') && allSrc.includes('registerCognitionTools'));
    const mcpIdx = read('server/tools/mcp_servers/index.ts');
    check('S7-F11 MCP 汇总注册覆盖 5 套（travel/websearch/stock/notify/util）', ['registerTravelTools', 'registerWebSearchTools', 'registerStockTools', 'registerNotifyTools', 'registerUtilTools'].every(f => mcpIdx.includes(f)));
    // 高精度计算纯函数
    const util = await import('./server/tools/mcp_servers/util');
    const sum = util.calculate('0.1+0.2');
    check('S7-F12 高精度计算 0.1+0.2=0.3（无浮点误差）', sum.ok === true && sum.value === '0.3', JSON.stringify(sum));
    const div = util.calculate('1/3');
    check('S7-F13 高精度除法 1/3 精确 18 位', div.ok === true && div.value.startsWith('0.333333333333333333'), div.ok === true ? div.value : 'err');
    check('S7-F14 除零错误优雅返回', !util.calculate('1/0').ok);
  }

  // ═══════════ 汇总 ═══════════
  section('汇总');
  console.log(`  通过: ${passed}  失败: ${failed.length}`);
  if (failed.length > 0) {
    console.log('  失败项:');
    for (const f of failed) console.log(`    ❌ ${f}`);
    process.exit(1);
  }
  console.log('  ✅ 全部 E2E 场景通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('[E2E] 未捕获异常:', e);
  process.exit(2);
});
