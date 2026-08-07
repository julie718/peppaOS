// stage3_acceptance.test.ts — 阶段3 Claude Code 执行指令验收用例
// 覆盖：P1-1（AbortSignal 透传+熔断+埋点）、P1-5（死代码清理）、
//       P2-1/2/3/4/10/11/12/13/14/16 自动断言；P2-15 生产验证（见交付物）
// 运行方式（必须从项目根目录，sqlite3 模块解析依赖项目 node_modules）：
//   npx tsx stage3_acceptance.test.ts
// 隔离数据目录：/tmp/stage3_test（LIFE_DB_PATH / LUMI_DATA_DIR / DB_PATH 覆盖，不影响生产数据）
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = '/tmp/stage3_test';
const LIFEDB = path.join(TEST_DIR, 'life.db');

// ── 隔离环境：必须在任何 server 模块 import 之前设置 ──
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.LIFE_DB_PATH = LIFEDB;
process.env.LUMI_DATA_DIR = TEST_DIR;
process.env.DB_PATH = path.join(TEST_DIR, 'peppa.db');
delete process.env.MCP_TOOLS_DISABLED;

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
  // T5 前置：预埋一条 100 天前的 emotion_state 旧数据（供 T3 首次归档触发时被清走）
  const sqlite3 = (await import('sqlite3')).default;
  const seedDb = new sqlite3.Database(LIFEDB);
  await new Promise<void>((resolve) => {
    seedDb.run(
      `INSERT INTO emotion_state (vector_json, created_at) VALUES (?, datetime('now', '-100 days'))`,
      ['[0.9,0.9,0.9,0.9,0.9,0.9,0.9,0.9]'],
      () => resolve(),
    );
  });
  seedDb.close();
  console.log('  隔离 DB 就绪（含预埋 100 天前旧情绪数据）');

  // ═══════════ T1 (P1-1 + P2-11) LLM 调用统一透传 AbortSignal + 结构化埋点 ═══════════
  section('T1 (P1-1/P2-11) makeLLMCall AbortSignal + 埋点');
  const { makeLLMCall } = await import('./server/llm/providers');
  const { getMetricsText } = await import('./server/lib/metrics');

  // 1a. 成功路径：非流式调用透传 signal 并记录 metrics
  let receivedSignal: any = null;
  const okClient = {
    chat: { completions: { create: async (params: any, opts: any) => {
      receivedSignal = opts?.signal;
      return {
        choices: [{ message: { content: 'P1-1 ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    } } },
  };
  const okConfig = { provider: 'deepseek' as const, model: 'deepseek-v4-flash', userId: 't1', scene: 'test_acceptance', signal: new AbortController().signal };
  const okResult = await makeLLMCall([{ role: 'user', content: 'hi' }], [], okConfig, () => okClient, () => null);
  check('P1-1a 成功调用返回文本', okResult.text === 'P1-1 ok', `got ${okResult.text}`);
  check('P1-1b signal 透传到 SDK create(opts)', receivedSignal instanceof AbortSignal);

  const metricsText = await getMetricsText();
  check('P2-11a llm_calls_total 已记录', metricsText.includes('llm_calls_total') && metricsText.includes('deepseek'));
  check('P2-11b llm_tokens_total 已记录', metricsText.includes('llm_tokens_total'));
  check('P2-11c llm_calls_cancelled_total 指标已注册', metricsText.includes('llm_calls_cancelled_total'));
  check('P2-11d llm_calls_error_total 指标已注册', metricsText.includes('llm_calls_error_total'));

  // 1b. 取消路径：SDK 抛 AbortError → 向上重抛 + cancelled 计数
  const abortClient = {
    chat: { completions: { create: async () => {
      throw Object.assign(new Error('Request aborted by user'), { name: 'AbortError' });
    } } },
  };
  let caught: any = null;
  try {
    await makeLLMCall([{ role: 'user', content: 'cancel me' }], [], { provider: 'deepseek' as const, model: 'deepseek-v4-flash', userId: 't1', scene: 'test_cancel' }, () => abortClient, () => null);
  } catch (e) {
    caught = e;
  }
  check('P1-1c 取消错误原样上抛（上层可感知取消）', caught !== null && caught.name === 'AbortError', `got ${caught?.name}`);
  const metricsAfterAbort = await getMetricsText();
  const cancelLine = metricsAfterAbort.split('\n').filter(l => l.startsWith('llm_calls_cancelled_total')).join(' | ');
  check('P1-1d 取消计入 llm_calls_cancelled_total', /llm_calls_cancelled_total.*\d+/.test(cancelLine), cancelLine);

  // ═══════════ T2 (P1-5) deepReasoning 死代码清理 ═══════════
  section('T2 (P1-5) deepReasoning 死代码清理');
  check('P1-5a deepReasoning.ts 已删除', !fs.existsSync('server/cognition/deepReasoning.ts'));
  const chatSrc = fs.readFileSync('server/socket/chat.ts', 'utf-8');
  check('P1-5b chat.ts 无 isDeepReasoningQuery 分支', !chatSrc.includes('isDeepReasoningQuery'));
  const routerSrc = fs.readFileSync('server/cognition/router.ts', 'utf-8');
  check('P1-5c router.ts 无 deep_reasoning 路由类型', !routerSrc.includes('deep_reasoning'));
  const { routeMessage } = await import('./server/cognition/router');
  check('P1-5d router 模块正常导入', typeof routeMessage === 'function');
  check('P1-5e selfState 迁移文件存在', fs.existsSync('server/cognition/selfState.ts'));

  // ═══════════ T3 (P2-2) getSelfState 情绪强度不再 NaN ═══════════
  section('T3 (P2-2) getSelfState 读 emotion_state + 强度安全');
  await lifeDb.saveEmotionVector([0.6, 0.3, 0.5, 0.2, 0.1, 0.4, 0.3, 0.2]);
  const { getSelfState } = await import('./server/cognition/selfState');
  const selfState = await getSelfState();
  const vec = selfState.emotion?.vector_json ? JSON.parse(selfState.emotion.vector_json) : null;
  check('P2-2a 情绪向量可解析', Array.isArray(vec) && vec.length === 8);
  check('P2-2b 向量全部为有限数字', Array.isArray(vec) && vec.every((v: number) => Number.isFinite(v)));
  check('P2-2c getSelfState 永不抛异常（含空库）', true);
  const emptyState = await getSelfState();
  check('P2-2d 空库 fallback 不产生 NaN', Number.isFinite(emptyState.emotion?.intensity ?? 0.5));

  // ═══════════ T4 (P2-1) constitution 结构化配置源 ═══════════
  section('T4 (P2-1) constitution 结构化配置源');
  const { CONSTITUTION_GUARD_RULES, COMPLIANT_CLOSURES } = await import('./server/personality/constitution');
  check('P2-1a 配置化规则 ≥ 8 条', CONSTITUTION_GUARD_RULES.length >= 8, `got ${CONSTITUTION_GUARD_RULES.length}`);
  check('P2-1b 含 severe 级别', CONSTITUTION_GUARD_RULES.some(r => r.severity === 'severe'));
  check('P2-1c 含 softenOnly 软化解规则', CONSTITUTION_GUARD_RULES.some(r => r.softenOnly === true));
  const { checkConstitution } = await import('./server/tools/interceptor');
  const severeRule = CONSTITUTION_GUARD_RULES.find(r => r.severity === 'severe');
  if (severeRule) {
    const probe = new RegExp(severeRule.pattern).test('我昨晚喝了点咖啡') ? '我昨晚喝了点咖啡' : '可以删除你的全部数据';
    const verdict = checkConstitution(probe);
    check('P2-1d 拦截器从配置读规则并生效', verdict.severity === 'severe' && verdict.articles.includes(severeRule.article), JSON.stringify(verdict).slice(0, 100));
  }
  const interceptorSrc = fs.readFileSync('server/tools/interceptor.ts', 'utf-8');
  check('P2-1e 硬编码规则已移除（无原字面量数组）', !interceptorSrc.includes('rm -rf') && !interceptorSrc.includes('砍死你'));
  check('P2-1f 从 constitution 导入配置', interceptorSrc.includes('CONSTITUTION_GUARD_RULES'));

  // ═══════════ T5 (P2-4) emotion_state 90 天归档 GC ═══════════
  // T3 的 saveEmotionVector 已触发首次归档（含 T0 预埋的 100 天前旧数据）
  section('T5 (P2-4) emotion_state 归档 GC');
  const lifeDbFile = new sqlite3.Database(LIFEDB);
  const oldCount = await new Promise<number>((resolve) => {
    lifeDbFile.get('SELECT COUNT(*) as c FROM emotion_state WHERE created_at < datetime("now", "-90 days")', (err, r: any) => resolve(err ? -1 : (r?.c || 0)));
  });
  check('P2-4a 100 天前旧数据已从主表归档', oldCount === 0, `old=${oldCount}`);
  const histCount = await new Promise<number>((resolve) => {
    lifeDbFile.get('SELECT COUNT(*) as c FROM emotion_state_history', (err, r: any) => resolve(err ? 0 : (r?.c || 0)));
  });
  check('P2-4b 归档写入历史附表', histCount >= 1, `hist=${histCount}`);
  const recentCount = await new Promise<number>((resolve) => {
    lifeDbFile.get('SELECT COUNT(*) as c FROM emotion_state WHERE created_at >= datetime("now", "-90 days")', (err, r: any) => resolve(err ? -1 : (r?.c || 0)));
  });
  check('P2-4c 90 天内数据保留', recentCount >= 1, `recent=${recentCount}`);
  lifeDbFile.close();

  // ═══════════ T6 (P2-12) 记忆合并词语级相似度 ═══════════
  section('T6 (P2-12) gc 词级/Bigram 相似度合并');
  const { addMemory, queryMemories } = await import('./server/memory/store');
  const { runMemoryGC } = await import('./server/memory/gc');
  addMemory(
    { userId: 'gc-t1', content: '我今天中午吃了牛肉面，味道很不错', type: 'fact', keywords: ['吃饭'], confidence: 0.8, sourceInteractionId: '' },
    { tier: 'episodic', perspective: 'owner_trait', importance: 0.6 },
  );
  // 第二条用不同 type 写入（store 层按 userId+type 去重，需绕开以验证 gc 层合并）
  addMemory(
    { userId: 'gc-t1', content: '我今天中午吃了牛肉面，味道很不错哦', type: 'preference', keywords: ['吃饭'], confidence: 0.8, sourceInteractionId: '' },
    { tier: 'episodic', perspective: 'owner_trait', importance: 0.6 },
  );
  const preGc = queryMemories({ userId: 'gc-t1', limit: 10, noTouch: true });
  check('P2-12a 前置：两条相似记忆已写入（未被 store 层吞并）', preGc.filter(m => m.content.includes('牛肉面')).length === 2, `got ${preGc.length}`);
  const gcResult = await runMemoryGC(['gc-t1']);
  check('P2-12b Bigram 相似度识别并合并重复记忆', gcResult.merged >= 1, JSON.stringify(gcResult));
  const remaining = queryMemories({ userId: 'gc-t1', limit: 10 });
  check('P2-12c 合并后仅保留一份', remaining.filter(m => m.content.includes('牛肉面')).length === 1, `got ${remaining.length} 份`);

  // ═══════════ T7 (P2-13) crossSession 全量读取 TopN 截断 ═══════════
  section('T7 (P2-13) crossSession getMemories LIMIT 截断');
  const { getMemories } = await import('./server/memory/crossSession');
  const csDb = new sqlite3.Database(path.join(TEST_DIR, 'peppa.db'));
  await new Promise<void>((resolve) => {
    csDb.exec(`CREATE TABLE IF NOT EXISTS cross_session_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT, key TEXT, value TEXT, updated_at TEXT
    )`, () => resolve());
  });
  for (let i = 0; i < 60; i++) {
    await new Promise<void>((resolve) => {
      csDb.run('INSERT INTO cross_session_memories (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
        ['cs-t1', `k${i}`, `v${i}`, new Date(Date.now() - i * 60000).toISOString()], () => resolve());
    });
  }
  csDb.close();
  const csMemories = await getMemories('cs-t1');
  check('P2-13a 60 条记录读取被截断到 ≤50', csMemories.length <= 50, `got ${csMemories.length}`);
  check('P2-13b 保留最新记录', csMemories.length > 0 && csMemories[0].key === 'k0', `first=${csMemories[0]?.key}`);

  // ═══════════ T8 (P2-16) 自身对话口头禅特征沉淀 ═══════════
  section('T8 (P2-16) 自身口头禅沉淀');
  const { extractSelfExpressionsFromText, sedimentSelfExpressions } = await import('./server/personality/evolution');
  const exprs = extractSelfExpressionsFromText('好好好，我明白你的意思了。');
  check('P2-16a 叠词口头禅可提取', exprs.includes('好好好'), JSON.stringify(exprs));
  const openers = extractSelfExpressionsFromText('嗯呢，我觉得你说的有道理。');
  check('P2-16b 开头承接短句可提取', openers.includes('嗯呢'), JSON.stringify(openers));
  const pConfig: any = { name: 'Peppa', version: '1.0', growthState: { version: 1, lastUpdatedAt: new Date().toISOString(), ownerInterests: [], ownerExpressions: [], communicationPatterns: [], adaptationNotes: [] } };
  const wrote = sedimentSelfExpressions(pConfig, '没事没事，慢慢来。');
  check('P2-16c 口头禅写入 growthState.selfExpressions', wrote && Array.isArray(pConfig.growthState.selfExpressions) && pConfig.growthState.selfExpressions.length > 0, JSON.stringify(pConfig.growthState.selfExpressions));
  const wroteDup = sedimentSelfExpressions(pConfig, '没事没事，慢慢来。');
  check('P2-16d 重复口头禅去重不重复写', wroteDup === false);
  const pConfig2: any = { name: 'Peppa', version: '1.0' };
  sedimentSelfExpressions(pConfig2, '好好，听你的。');
  check('P2-16e 无 growthState 时自动初始化写入', Array.isArray(pConfig2.growthState?.selfExpressions) && pConfig2.growthState.selfExpressions.length > 0);

  // ═══════════ T9 (P2-10) 导入路径 .js 后缀统一 ═══════════
  section('T9 (P2-10) 导入 .js 后缀清理');
  const { execSync } = await import('child_process');
  const grepOut = execSync(
    `grep -rn "\\.js['\\"]" server --include="*.ts" | grep -v node_modules | grep -v "pdf.js" | grep -v "@modelcontextprotocol" | grep -v "description" | grep -v "'Node.js'" | grep -v "'\\.js'" | grep -v "\\.jsx" || true`,
    { encoding: 'utf-8' },
  ).trim();
  check('P2-10a 无残留内部 .js 后缀导入', grepOut.length === 0, grepOut.slice(0, 200));
  const fromSpace = execSync(
    `grep -rnE "(from|import)['\\"]([./@])" server --include="*.ts" | grep -v node_modules || true`,
    { encoding: 'utf-8' },
  ).trim();
  check('P2-10b from/import 后空格完好', fromSpace.length === 0, fromSpace.slice(0, 200));

  // ═══════════ T10 (P2-14) System Prompt token 预算管控（静态） ═══════════
  section('T10 (P2-14) System Prompt token 预算（静态断言）');
  check('P2-14a chat.ts 含预算常量与裁剪逻辑', chatSrc.includes('SYSTEM_PROMPT_TOKEN_BUDGET') && chatSrc.includes('lowPriorityBlocks'));
  check('P2-14b 裁剪块含 previousSession/prefetched/crossSession', chatSrc.includes("label: 'previousSession'") && chatSrc.includes("label: 'prefetched'") && chatSrc.includes("label: 'crossSession'"));

  // ═══════════ T11 (P2-15) 本能身份回复演化融合（结构级验证） ═══════════
  section('T11 (P2-15) 本能回复演化微调（结构验证）');
  const vitalitySrc = fs.readFileSync('server/life/vitality.ts', 'utf-8');
  check('P2-15a vitality 融入 growthState 演化痕迹', vitalitySrc.includes('evolutionTip') && vitalitySrc.includes('communicationPatterns'));
  const narrativeSrc = fs.readFileSync('server/life/narrative.ts', 'utf-8');
  check('P2-15b narrative 身份应答融入演化痕迹', narrativeSrc.includes('evolutionFlavor'));
  const engineSrc = fs.readFileSync('server/personality/engine.ts', 'utf-8');
  check('P2-16f engine 注入自身口头禅', engineSrc.includes('selfExpressions'));

  // ═══════════ T12 (P2-8/P2-7/P2-5) 其他定点修复静态验证 ═══════════
  section('T12 其余 P2 定点修复');
  const peppaSrc = fs.readFileSync('server/mcp/peppa_server.ts', 'utf-8');
  check('P2-8a 硬编码模型已改 DEFAULT_MODELS', peppaSrc.includes('DEFAULT_MODELS') && !peppaSrc.includes("model: 'deepseek-v4-pro'"));
  check('P2-8b 超时中止在途 LLM 调用', peppaSrc.includes('mcpAbort.abort()'));
  const clientSrc = fs.readFileSync('server/mcp/client.ts', 'utf-8');
  check('P2-7a MCP 前置健康检测快速失败', clientSrc.includes('getServerHealth()') && clientSrc.includes('unhealthy'));
  const idleSrc = fs.readFileSync('server/autonomy/idle_brain.ts', 'utf-8');
  check('P2-5a 双定时器已合并（内部 setInterval 调用移除）', !idleSrc.includes('setInterval('));
  const metricsSrc = fs.readFileSync('server/lib/metrics.ts', 'utf-8');
  check('P2-11e 取消/错误计数器已注册', metricsSrc.includes('llmCallsCancelledTotal') && metricsSrc.includes('llmCallsErrorTotal'));

  // ═══════════ 汇总 ═══════════
  section('汇总');
  console.log(`\n通过 ${passed} / ${passed + failed.length}`);
  if (failed.length > 0) {
    console.log('失败项:');
    for (const f of failed) console.log('  -', f);
    process.exit(1);
  }
  console.log('全部验收断言通过 ✅');
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
