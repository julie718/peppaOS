// test/deepseek_router.test.ts
// DeepSeek 外部强制路由中间层测试（任务8 手动测试用例 → 自动化断言）
//
// 覆盖验证点：
//   1. 心智请求（inner_tick）强制落到 deepseek-v4-pro；
//   2. 外围渲染（chat）强制落到 deepseek-v4-flash；
//   3. pro 故障（429）触发 flash 应急降级（evolution 等非 innerTick 核心场景）；
//   4. inner_tick 故障禁止降级到 flash（降级状态禁止触发完整 InnerTick 深度推演）；
//   5. 预算耗尽 → 核心心智进入休眠只读（数据不丢失：拒绝调用而非写入残缺数据），flash 外围不受影响；
//   6. 空闲频率闸门：间隔内拦截空闲 InnerTick，间隔外放行；
//   7. 前缀缓存：system 消息稳定置顶；usage 含缓存命中 token。
//
// 环境隔离：临时 LUMI_DATA_DIR / DB_PATH / 假 DEEPSEEK_API_KEY，不影响生产数据。
// 注意：路由模块链式依赖 db_layer（模块加载时解析 DB_PATH），因此除 vitest 与 node
// 内置模块外全部使用动态 import，保证环境变量先于模块加载生效。

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const tmpRoot = path.join(os.tmpdir(), `deepseek_router_test_${crypto.randomUUID().slice(0, 8)}`);
fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'data', '.migration_skip'), '');
process.env.LUMI_DATA_DIR = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, 'peppa.db');
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';

let db: any;
let providers: typeof import('../server/llm/providers');
let mindRouter: typeof import('../server/llm/mindRouter');
let budgetGate: typeof import('../server/llm/budgetGate');
let frequencyGate: typeof import('../server/llm/frequencyGate');
let routerConfig: typeof import('../server/llm/routerConfig');
let cloudCore: typeof import('../server/cloud/core');

beforeAll(async () => {
  db = await import('../db_layer');
  await db.initDatabase();
  // qwen 外围调用测试需要用户偏好上下文（assertQwenAllowedByUserPrefs 闸门）：
  // 预置 llm_prefs_qwenuser = 主推理脑 qwen / qwen-max
  const dbx = db.readDB();
  if (!dbx.settings) dbx.settings = [];
  dbx.settings.push({
    key: 'llm_prefs_qwenuser',
    value: JSON.stringify({ provider: 'qwen', models: { qwen: 'qwen-max' } }),
  });
  db.writeDB(dbx);
  providers = await import('../server/llm/providers');
  mindRouter = await import('../server/llm/mindRouter');
  budgetGate = await import('../server/llm/budgetGate');
  frequencyGate = await import('../server/llm/frequencyGate');
  routerConfig = await import('../server/llm/routerConfig');
  cloudCore = await import('../server/cloud/core');
});

// 故障注入会累积熔断器失败计数（阈值 5，跨用例共享），每个用例后复位
afterEach(() => {
  cloudCore.resetCircuit();
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

/** 构造假 DeepSeek OpenAI 兼容客户端：记录收到的 model/messages，可按序定制行为 */
function makeFakeClient(opts: {
  onRequest?: (params: { model: string; messages: any[] }) => void;
  behaviors?: Array<'ok' | 'fail-429' | 'fail-500' | 'fail-402'>;
}) {
  const calls: Array<{ model: string; messages: any[] }> = [];
  let callIdx = 0;
  const client = {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push({ model: params.model, messages: params.messages });
          const behavior = opts.behaviors?.[callIdx] || 'ok';
          callIdx++;
          opts.onRequest?.(params);
          if (behavior === 'fail-429') throw new Error('429 Too Many Requests — rate limit');
          if (behavior === 'fail-500') throw new Error('500 Internal Server Error');
          if (behavior === 'fail-402') throw new Error('402 Insufficient Balance');
          return {
            choices: [{ message: { content: JSON.stringify({ ok: true, model: params.model }) } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 30 },
          };
        },
      },
    },
  };
  return { client, calls };
}

function gettersFor(fake: { client: any }, opts?: { qwenClient?: any }) {
  return {
    getDeepSeek: () => fake.client,
    getGemini: () => null,
    getOpenAI: () => null,
    getAnthropic: () => null,
    getQwen: () => opts?.qwenClient || null,
    getOllama: () => null,
    getLmStudio: () => null,
    getArk: () => null,
    getXiaomi: () => null,
    getKimi: () => null,
    getGlm: () => null,
    getRelay: () => null,
  };
}

const cfg = (scene: string) => ({ provider: 'deepseek' as const, model: 'deepseek-chat', scene });
const EMPTY_TOOLS: any[] = [];

// ─────────────────────────────────────────────
// 1) 强制分发：核心心智 → pro / 外围 → flash
// ─────────────────────────────────────────────

describe('强制分发（任务2）', () => {
  it('核心心智 inner_tick 强制落到 deepseek-v4-pro（不理会调用方自带的模型名）', async () => {
    const fake = makeFakeClient({});
    const g = gettersFor(fake);
    const result = await providers.makeLLMCall(
      [{ role: 'system', content: '你是数字生命体内部心智。' }, { role: 'user', content: '推演' }],
      EMPTY_TOOLS, cfg('inner_tick'),
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    expect(fake.calls[0].model).toBe('deepseek-v4-pro');
    expect(result.text).toContain('deepseek-v4-pro');
  });

  it('外围输出 chat 强制落到 deepseek-v4-flash', async () => {
    const fake = makeFakeClient({});
    const g = gettersFor(fake);
    await providers.makeLLMCall(
      [{ role: 'user', content: '你好' }],
      EMPTY_TOOLS, cfg('chat'),
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    expect(fake.calls[0].model).toBe('deepseek-v4-flash');
  });

  it('未标记 scene 的调用按外围处理（deepseek 服务商强制 flash）', async () => {
    const fake = makeFakeClient({});
    const g = gettersFor(fake);
    await providers.makeLLMCall(
      [{ role: 'user', content: 'x' }],
      EMPTY_TOOLS, { provider: 'deepseek', model: 'deepseek-chat' },
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    expect(fake.calls[0].model).toBe('deepseek-v4-flash');
  });

  it('核心心智强制锁定 deepseek：即使调用方配置 qwen 也被切到 deepseek-v4-pro', async () => {
    const fake = makeFakeClient({});
    const g = gettersFor(fake);
    await providers.makeLLMCall(
      [{ role: 'user', content: '推演' }],
      EMPTY_TOOLS, { provider: 'qwen', model: 'qwen-max', scene: 'inner_tick' },
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    expect(fake.calls[0].model).toBe('deepseek-v4-pro');
  });

  it('非 deepseek 服务商的外围调用保持原模型（不把 flash 强塞给 qwen）', async () => {
    const fake = makeFakeClient({});
    // qwen 调用走 getQwen 客户端（复用同一 fake 容器即可验证 model 未被改写）
    const g = gettersFor(fake, { qwenClient: fake.client });
    await providers.makeLLMCall(
      [{ role: 'user', content: '你好' }],
      EMPTY_TOOLS, { provider: 'qwen', model: 'qwen-max', scene: 'chat', userId: 'qwenuser' },
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    expect(fake.calls[0].model).toBe('qwen-max');
  });
});

// ─────────────────────────────────────────────
// 2) 故障 fallback：pro 报错 → flash 应急；inner_tick 例外
// ─────────────────────────────────────────────

describe('故障降级（任务2）', () => {
  it('pro 返回 429 限流 → 核心场景（evolution）自动降级 flash 重试一次，接口恢复后下次自动回 pro', async () => {
    // Phase-2 重试收紧（item 9）：evolution 属后台核心心智场景 → 0 次重试（PEPPA_BG_LLM_RETRY=0，
    // 防重试风暴），pro 失败 1 次即由路由层应急降级 flash（降级是换模型，不是重试）
    const fake = makeFakeClient({ behaviors: ['fail-429', 'ok'] });
    const g = gettersFor(fake);
    const result = await providers.makeLLMCall(
      [{ role: 'system', content: '人格演化' }, { role: 'user', content: '演化' }],
      EMPTY_TOOLS, cfg('evolution'),
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    // 后台场景不重试：pro 仅 1 次尝试，失败后应急降级 flash 一次
    const proCalls = fake.calls.filter((c) => c.model === 'deepseek-v4-pro');
    const flashCalls = fake.calls.filter((c) => c.model === 'deepseek-v4-flash');
    expect(proCalls).toHaveLength(1);                          // 重试收紧：0 次 pro 重试
    expect(fake.calls[0].model).toBe('deepseek-v4-pro');       // 永远先探测 pro
    expect(flashCalls).toHaveLength(1);
    expect(fake.calls[fake.calls.length - 1].model).toBe('deepseek-v4-flash'); // 最后一次是降级调用
    expect(result.text).toContain('deepseek-v4-flash');

    // 调用记录带降级标记
    const dbx = db.readDB();
    const rec = dbx.llmRouterCalls[dbx.llmRouterCalls.length - 1];
    expect(rec.tier).toBe('core_mind');
    expect(rec.degraded).toBe(true);
    expect(rec.model).toBe('deepseek-v4-flash');
  });

  it('余额不足 402 → 同样触发 flash 应急降级', async () => {
    const fake = makeFakeClient({ behaviors: ['fail-402', 'ok'] });
    const g = gettersFor(fake);
    await providers.makeLLMCall(
      [{ role: 'user', content: 'x' }],
      EMPTY_TOOLS, cfg('narrative'),
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].model).toBe('deepseek-v4-flash');
  });

  it('inner_tick 主模型故障 → 禁止降级到 flash 深度推演（pro 全失败后错误上抛给零写入兜底，绝无 flash）', async () => {
    // 3 次尝试全失败（429 可重试）→ 错误上抛；inner_tick 不降级 flash
    const fake = makeFakeClient({ behaviors: ['fail-429', 'fail-429', 'fail-429'] });
    const g = gettersFor(fake);
    await expect(
      providers.makeLLMCall(
        [{ role: 'user', content: '推演' }],
        EMPTY_TOOLS, cfg('inner_tick'),
        g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
      ),
    ).rejects.toThrow(/429/);
    expect(fake.calls.length).toBeGreaterThan(0);                       // 全部为 pro 尝试
    expect(fake.calls.every((c) => c.model === 'deepseek-v4-pro')).toBe(true); // 绝无 flash 深度推演
  });
});

// ─────────────────────────────────────────────
// 3) 预算熔断：休眠只读模式（数据不丢失 = 拒绝调用而非写入残缺数据）
// ─────────────────────────────────────────────

describe('预算熔断（任务5）', () => {
  it('预算耗尽 → inner_tick 拒绝执行（BudgetSleepError），flash 外围调用不受影响', async () => {
    const prevBudget = process.env.DEEPSEEK_ROUTER_DAILY_PRO_TOKEN_BUDGET;
    process.env.DEEPSEEK_ROUTER_DAILY_PRO_TOKEN_BUDGET = '1000';
    budgetGate.resetTodayUsage();
    // 模拟已消耗 1200 token（超过预算 1000）
    budgetGate.recordProTokens({ promptTokens: 1200, completionTokens: 0, cacheHitTokens: 0 });
    expect(budgetGate.getBudgetState()).toBe('sleep');

    const fake = makeFakeClient({});
    const g = gettersFor(fake);

    // 核心心智：直接拒绝（未发起任何 LLM 调用 → 不消耗 token、不写入残缺心智数据）
    await expect(
      providers.makeLLMCall(
        [{ role: 'user', content: '推演' }],
        EMPTY_TOOLS, cfg('inner_tick'),
        g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
      ),
    ).rejects.toThrow(/预算已耗尽/);
    expect(fake.calls).toHaveLength(0); // 零 LLM 请求

    // flash 外围调用不受熔断约束（chat 照常工作）
    const result = await providers.makeLLMCall(
      [{ role: 'user', content: '你好' }],
      EMPTY_TOOLS, cfg('chat'),
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    expect(result.text).toContain('deepseek-v4-flash');

    // 恢复（新的一天/手动重置 → 自动恢复运行）
    budgetGate.resetTodayUsage();
    expect(budgetGate.getBudgetState()).toBe('normal');
    const again = await providers.makeLLMCall(
      [{ role: 'user', content: '推演' }],
      EMPTY_TOOLS, cfg('inner_tick'),
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    expect(again.text).toContain('deepseek-v4-pro'); // 恢复后自动回到 pro

    if (prevBudget === undefined) delete process.env.DEEPSEEK_ROUTER_DAILY_PRO_TOKEN_BUDGET;
    else process.env.DEEPSEEK_ROUTER_DAILY_PRO_TOKEN_BUDGET = prevBudget;
  });
});

// ─────────────────────────────────────────────
// 4) 空闲频率管控
// ─────────────────────────────────────────────

describe('空闲 InnerTick 频率管控（任务4）', () => {
  it('间隔内拦截空闲触发，间隔外放行；间隔 0 = 恒放行（旧行为）', () => {
    const prev = process.env.DEEPSEEK_ROUTER_IDLE_INNERTICK_INTERVAL_MS;
    process.env.DEEPSEEK_ROUTER_IDLE_INNERTICK_INTERVAL_MS = '600000'; // 10 分钟

    // 清理上次状态
    const dbx = db.readDB();
    dbx.settings = (dbx.settings || []).filter((s: any) => s.key !== 'llm_router_idle_tick');
    db.writeDB(dbx);

    expect(frequencyGate.allowIdleInnerTick('idle_brain')).toBe(true);   // 首次：放行
    expect(frequencyGate.allowIdleInnerTick('idle_brain')).toBe(false);  // 间隔内：拦截（不调用大模型）
    expect(frequencyGate.getLastIdleInnerTickAt()).toBeTruthy();

    // 间隔 0 = 不限制（保持旧行为）
    process.env.DEEPSEEK_ROUTER_IDLE_INNERTICK_INTERVAL_MS = '0';
    expect(frequencyGate.allowIdleInnerTick('idle_brain')).toBe(true);

    if (prev === undefined) delete process.env.DEEPSEEK_ROUTER_IDLE_INNERTICK_INTERVAL_MS;
    else process.env.DEEPSEEK_ROUTER_IDLE_INNERTICK_INTERVAL_MS = prev;
  });
});

// ─────────────────────────────────────────────
// 5) 前缀缓存适配（任务3）
// ─────────────────────────────────────────────

describe('DeepSeek 前缀缓存适配（任务3）', () => {
  it('system 消息稳定置顶：无论调用方消息顺序，请求内 system 必在头部（静态前缀）', () => {
    const request = providers.formatDeepSeekRequest({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: '动态对话' },
        { role: 'system', content: '固定 system 头部（勿频繁修改）' },
        { role: 'user', content: '更多动态内容' },
      ],
      toolDeclarations: [{ type: 'function', function: { name: 'mcp_tool', description: 'x', parameters: {} } }] as any,
    });
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toBe('固定 system 头部（勿频繁修改）');
    // 动态内容保留在尾部，顺序不变
    expect(request.messages[1]).toMatchObject({ role: 'user', content: '动态对话' });
    expect(request.messages[2]).toMatchObject({ role: 'user', content: '更多动态内容' });
  });

  it('usage 提取含 DeepSeek 前缀缓存命中 token（prompt_cache_hit_tokens）', async () => {
    const fake = makeFakeClient({});
    const g = gettersFor(fake);
    const result = await providers.makeLLMCall(
      [{ role: 'user', content: '缓存命中测试' }],
      EMPTY_TOOLS, cfg('chat'),
      g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay,
    );
    expect((result.usage as any).cacheHitTokens).toBe(30);
    expect((result.usage as any).promptTokens).toBe(100);
  });

  it('路由状态接口返回配置/预算/今日统计/核心心智场景清单', () => {
    const status = mindRouter.getRouterStatus();
    expect(status.proModel).toBe('deepseek-v4-pro');
    expect(status.flashModel).toBe('deepseek-v4-flash');
    expect(status.coreMindScenes).toContain('inner_tick');
    expect(status.budgetState).toBeDefined();
    expect(status.todayCounts).toBeDefined();
  });
});
