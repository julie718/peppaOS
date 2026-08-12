# DeepSeek 最高性价比外部强制路由方案 — 交付报告

> 实现方式：**外部强制路由中间层**（服务端单一汇聚点外置执行），心智本体业务代码（innerTick / life TICK / 自我反思模块）零修改。
> 硬性约束执行情况：核心心智强制锁定 `deepseek-v4-pro`，flash 仅用于外围输出；无「心智自主选择模型」，全部分发由路由代码硬规则执行；Web 桌面管理界面提供全部配置入口；iPhone App 复用服务端全局配置（未新增任何客户端设置）。

---

## 一、完整改动文件清单

### 新增文件（4 个核心模块 + 1 个测试）

| 文件 | 职责 |
|---|---|
| [server/llm/routerConfig.ts](../server/llm/routerConfig.ts) | 配置层：pro/flash 模型、每日预算、告警比例、空闲间隔、总开关；优先级 **环境变量 > Web 桌面配置(db.settings) > 默认值** |
| [server/llm/mindRouter.ts](../server/llm/mindRouter.ts) | 路由中间层核心：场景硬规则分类、模型强制分发、预算熔断闸门、故障降级判定、调用记录、状态接口 |
| [server/llm/budgetGate.ts](../server/llm/budgetGate.ts) | Token 预算熔断：每日汇总持久化（db.settings）、告警/休眠状态机、跨天自动滚动、`BudgetSleepError` |
| [server/llm/frequencyGate.ts](../server/llm/frequencyGate.ts) | 空闲 InnerTick 频率闸门：间隔内拦截（轻量快照不调大模型），持久化最后触发时间 |
| [test/deepseek_router.test.ts](../test/deepseek_router.test.ts) | 13 个自动化测试用例（任务8 手动用例全部落成断言） |

### 修改文件（9 个）

| 文件 | 改动 |
|---|---|
| [server/llm/providers.ts](../server/llm/providers.ts) | 唯一挂钩点：`makeLLMCall`/`makeLLMCallStreaming` 包装 beforeCall(熔断) → resolveRoute(强制分发) → 故障降级(429/402/5xx → flash 应急一次) → afterCall(记账+记录)；usage 提取 `prompt_cache_hit_tokens`；`formatDeepSeekRequest` 消息 system 稳定置顶（前缀缓存适配） |
| [server/mcp/peppa_server.ts](../server/mcp/peppa_server.ts) | 两处 `runWithTools` 补 `scene: 'mcp_eval'`（MCP 技能评估强制走 pro） |
| [server/autonomy/idle_brain.ts](../server/autonomy/idle_brain.ts) | 唯一触发点改动：`enableInnerTickIdleTrigger` 块内加 `allowIdleInnerTick` 频率闸门（配置开关，聊天/调度触发不受影响） |
| [server/routes/system_routes.ts](../server/routes/system_routes.ts) | `GET/PUT /preferences/llm-router`（配置）、`GET /llm/router-usage`（用量/预算状态）、`POST /llm/router/reset-usage`（手动重置） |
| [src/components/Settings.tsx](../src/components/Settings.tsx) | LLM 设置页新增「DeepSeek 心智路由」配置区：总开关/模型/预算/告警比例/空闲间隔 + 预算状态徽章 + 今日用量展示 + 手动唤醒（重置今日用量）按钮 |
| [db_layer.ts](../db_layer.ts) | 新增 `llm_router_calls` 持久表（建表迁移 + loadMemoryDB + persistMemoryDB spec 三处），任务7 每次调用记录跨重启不丢失 |
| [.env.example](../.env.example) | 6 个 `DEEPSEEK_ROUTER_*` 环境变量文档化 |
| [docker-compose.yml](../docker-compose.yml) | 6 个 `DEEPSEEK_ROUTER_*` 环境变量透传（`${VAR:-}`） |
| [deliverables/45_DeepSeek外部强制路由方案交付报告.md](45_DeepSeek外部强制路由方案交付报告.md) | 本报告 |

---

## 二、关键代码片段

### 1. 场景硬规则分类 + 模型强制分发（mindRouter.ts）

```typescript
/** 核心心智场景白名单（硬规则：这些请求绝不允许交给 flash） */
const CORE_MIND_SCENES: ReadonlySet<string> = new Set([
  'inner_tick', 'runtime_tick', 'evolution', 'narrative',
  'skill_gen', 'mcp_eval', 'agent_orchestrator', 'self_review',
]);

export function resolveRoute(config): RoutedConfig | null {
  const cfg = getRouterConfig();
  if (!cfg.enabled) return null;
  if (!isDeepSeekConfigured()) return null;

  const tier = classifyScene(config.scene);
  if (tier === 'core_mind') {
    // 核心心智强制锁定 deepseek-v4-pro：即使调用方配置了其他服务商也强制切到 DeepSeek
    if (config.provider !== 'deepseek' || config.model !== cfg.proModel) {
      return { tier, provider: 'deepseek', model: cfg.proModel, forced: true };
    }
    ...
  }
  // 外围输出：仅 deepseek 服务商强制用 flash（话术包装不需要 pro；不把 flash 强塞给 qwen/gemini）
  if (config.provider === 'deepseek' && config.model !== cfg.flashModel) {
    return { tier, provider: 'deepseek', model: cfg.flashModel, forced: true };
  }
  return null;
}
```

### 2. providers.ts 挂钩点（心智层零修改的关键）

```typescript
export async function makeLLMCall(...args) {
  const start = Date.now();
  beforeCall(config.scene);              // ① 预算熔断：休眠态下核心心智直接拒绝
  const routed = resolveRoute(config);   // ② 模型强制分发
  const effective = routed ? { ...config, provider: routed.provider, model: routed.model } : config;
  try {
    const result = await makeLLMCallCore(...coreArgs);
    afterCall(routed, effective, result.usage, start);   // ③ 记账 + 调用记录
    return result;
  } catch (err) {
    // ④ 故障降级：仅核心心智 + API 报错 → flash 应急重试一次
    if (routed?.tier === 'core_mind' && shouldFallbackToFlash(config.scene, err)) { ... }
    throw err;
  }
}
```

### 3. 故障降级判定（含 402 余额不足修复）

```typescript
export function isFallbackEligibleError(err: any): boolean {
  if (!err) return false;
  if (err?.name === 'AbortError' || err?.name === 'BudgetSleepError' || /abort|cancel/i.test(...)) return false;
  // 消息关键字优先匹配（含 402/insufficient balance）：classifyCloudError 会把
  // 「402 Insufficient Balance」归为 unknown，必须按 DeepSeek 真实错误文案兜底
  const msg = String(err?.message || '');
  if (/429|402|insufficient.?balance|quota|exceed|rate.?limit|\b5\d\d\b/i.test(msg)) return true;
  try {
    const cls = classifyCloudError(err);
    return FALLBACK_ELIGIBLE_CATEGORIES.has(cls.category);
  } catch { return false; }
}
```

### 4. inner_tick 禁止降级（降级状态禁止触发完整 InnerTick 深度推演）

```typescript
export function shouldFallbackToFlash(scene: string | undefined, err: any): boolean {
  if (scene === 'inner_tick') {
    logger.warn(`[LLMRouter] innerTick 主模型失败 → 降级状态禁止触发完整InnerTick深度推演：本轮不上flash，返回额度/接口异常提示，等待接口恢复后自动切回pro`);
    return false;  // 原始 pro 错误上抛 → innerTick 既有「零写入兜底」路径处理，数据不丢失
  }
  return isFallbackEligibleError(err);
}
```

### 5. 预算熔断（budgetGate.ts）

```typescript
export function recordProTokens(tokens): BudgetState {
  const cfg = getRouterConfig();
  const usage = readDaily();
  usage.proTokens += (tokens.promptTokens || 0) + (tokens.completionTokens || 0);
  usage.proCacheHitTokens += tokens.cacheHitTokens || 0;
  usage.proCalls += 1;
  const next = computeState(usage, cfg.dailyProTokenBudget, cfg.budgetWarnRatio); // normal → warn → sleep
  if (next === 'sleep' && usage.state !== 'sleep') {
    logger.error(`[BudgetGate-SLEEP] ⚠️ 今日 Pro token 预算已耗尽 → 进入休眠只读模式：核心心智深度推演全部暂停；记忆/人格/欲望数据完整保留，新的一天自动恢复`);
  }
  usage.state = next; writeDaily(usage);
  return next;
}

// 休眠错误：innerTick 捕获后按推演失败零写入处理（不消耗 token、不写残缺数据）
export class BudgetSleepError extends Error {
  readonly code = 'BUDGET_SLEEP';
  constructor(budget: number, used: number) { super(`[BudgetGate] 今日 Pro token 预算已耗尽（${used}/${budget}）...新的一天自动恢复。`); this.name = 'BudgetSleepError'; }
}
```

### 6. 空闲 InnerTick 频率管控（frequencyGate.ts + idle_brain.ts 触发点）

```typescript
// frequencyGate.ts
export function allowIdleInnerTick(source: string): boolean {
  const cfg = getRouterConfig();
  if (cfg.idleInnerTickIntervalMs <= 0) return true;   // 0 = 不限制（保持旧行为）
  const last = getLastIdleInnerTickAt();
  const now = Date.now();
  if (last && now - last < cfg.idleInnerTickIntervalMs) {
    logger.debug(`[LLMRouter] 空闲 InnerTick 被频率闸门拦截（距上次 ${Math.round((now-last)/1000)}s < ${cfg.idleInnerTickIntervalMs}ms）：本轮只做轻量快照，不调用大模型`);
    return false;
  }
  recordIdleInnerTickAt(now); return true;
}

// idle_brain.ts enableInnerTickIdleTrigger 块内（唯一触发点改动，受配置开关控制）
if (!allowIdleInnerTick('idle_brain')) {
  // 间隔未到：本轮跳过 LLM 深度推演（轻量快照照常产出）——用户消息交互(chat_turn)/
  // 重要状态变更触发的 InnerTick 不受此闸门影响
  return;
}
```

### 7. 前缀缓存适配（providers.ts formatDeepSeekRequest）

```typescript
// DeepSeek 前缀缓存（prompt_cache_hit_tokens）：system 指令/工具声明是静态前缀，
// 必须保持稳定并置于消息头部 —— 频繁修改 system 头部内容会破坏 KV 缓存命中率。
// 动态对话内容追加在尾部，静态前缀命中即可按缓存价格计费。
if (systemMessages.length > 0 && messages[0]?.role !== 'system') {
  messages = [...systemMessages, ...messages.filter((m) => m.role !== 'system')];
}
```

---

## 三、测试结果

### 自动化测试（新增 13 用例，全绿）

```
npx vitest run test/deepseek_router.test.ts
→ Test Files 1 passed | Tests 13 passed (13)

覆盖验证点：
 1. inner_tick 强制 deepseek-v4-pro（即使调用方配置 qwen 也被切走）
 2. chat 外围强制 deepseek-v4-flash；未标 scene 默认外围
 3. 非 deepseek 服务商外围（qwen）保持原模型，不硬塞 flash
 4. evolution 429（含重试耗尽）→ flash 应急降级一次，调用记录 degraded=true
 5. narrative 402 余额不足 → 同样降级 flash
 6. inner_tick 429 → 拒绝降级：全部 pro 尝试失败后错误上抛（绝无 flash 深度推演）
 7. 预算耗尽 → inner_tick 抛 BudgetSleepError（0 次 LLM 调用），chat 外围不受影响；重置后自动恢复 pro
 8. 频率闸门：间隔内拦截/间隔外放行；间隔 0 = 恒放行（旧行为）
 9. system 消息稳定置顶（前缀缓存）；usage 提取 cacheHitTokens=30
10. getRouterStatus 返回配置/预算状态/今日统计/核心心智场景清单
```

### 编译与回归

```
npx tsc --noEmit  → 通过（0 错误，硬性约束）
npx vitest run    → 226 passed / 9 failed（Test Files 27 passed / 8 failed）
```

**基线失败严格核验**（非「stash 对比」，而是独立 worktree 实证）：
`git worktree add /tmp/peppa-baseline HEAD`（f97461f，不含任何路由改动），挂载 node_modules 后运行同一批 9 个失败测试文件：
`rtf_extraction / language / wake_detector / lap_policy / adapter_registry_external_tools / markdown_knowledge / emotional_state / legal_semiauto_workflows`
→ **同一 9 个用例在基线上原样复现失败（Test Files 8 failed）**。结论：本次路由改动 **0 新增失败**，9 个均为改动前既有基线失败。

### 全局 grep 验证（Thoroughness Rule）

所有 `makeLLMCall` 调用点场景分类核对完毕，核心心智场景 100% 经过 makeLLMCall 汇聚点路由：

| 分类 | 场景（自动落 pro） | 场景（自动落 flash） |
|---|---|---|
| 核心心智 | inner_tick、runtime_tick、evolution、narrative、skill_gen、mcp_eval、agent_orchestrator | — |
| 外围输出 | — | chat、classifier、summary、identity_check、consolidate、memory_tree、extract、dream、focus_stack、weekly/monthly/yearly_report、growth_journal、proactive、voice_*、legal、music_*、dispatch_*、agent_*、wechat、marketplace、chat_route、memory_plan、vision 等 |

**已排除的 2 处历史直连调用点**（grep `chat.completions.create / messages.create / generateContent` 全仓核查，均为外围话术路径，非心智路径，且不属于任务限定的 9 个修改文件）：
1. `server/routes/chat_routes.ts:118-143` — **BYOK（用户自带 API key）**：使用用户自有 key 与自有模型直连，强制改道 deepseek 会导致用户 key 无效报错，属于设计排除（路由仅作用于服务商自身 DeepSeek 计费调用）；
2. `server/messaging/routes.ts:808` — **飞书自动回复**：走用户配置主推理脑、自带多服务商顺序降级逻辑的纯外围话术路径，不经心智内核；若强制改道会破坏其 provider 顺序回退设计。

两处均不产生 InnerTick/TICK/自我反思/MCP 评估类心智调用，不影响「核心心智绝不让 flash 推演」的硬性约束。

---

## 四、手动测试用例（NAS 部署后验证）

| # | 验证点 | 操作 | 预期 |
|---|---|---|---|
| 1 | 心智强制 pro | 观察 NAS 日志含 `scene=inner_tick` 或 `runtime_tick` 的行 | `[LLM] ok scene=inner_tick ... model=deepseek-v4-pro`；`[LLMRouter] ok tier=core_mind` |
| 2 | 外围强制 flash | 给 Peppa 发一条普通聊天 | 日志 `scene=chat ... model=deepseek-v4-flash`（含 user_preferences 里选择的 deepseek 模型名被改写） |
| 3 | pro 故障降级 | 临时把 DEEPSEEK_API_KEY 改成错误 key 后发复杂消息 | 日志出现 `pro 主模型故障...应急降级 deepseek-v4-flash 重试一次`，消息仍正常回复；改回 key 后自动回 pro |
| 4 | 预算休眠不丢数据 | Web 设置 `dailyProTokenBudget` 为小值，观察消耗超预算后 | 日志 `[BudgetGate-SLEEP]`；InnerTick 停止深度推演（`BudgetSleepError`，记忆/人格数据保留）；`GET /api/llm/router-usage` 显示 `budgetState: "sleep"`；次日或 POST `/api/llm/router/reset-usage` 后自动恢复 |
| 5 | 空闲不刷 InnerTick | 设置 `idleInnerTickIntervalMs=600000`，观察长时间无交互时日志 | 空闲轮只输出 `频率闸门拦截` debug 日志，无 `inner_tick` LLM 调用；发一条消息后（chat_turn 触发）InnerTick 恢复正常 |
| 6 | 配置持久化 | Web 界面修改任一配置项保存，重启容器 | `GET /api/preferences/llm-router` 返回修改后的值（db.settings 持久化）；env 变量优先于 Web 配置 |
| 7 | 缓存命中观测 | 连续两次触发同一场景（如两次聊天） | 第二次日志 `cacheHitTokens>0`，`GET /api/llm/router-usage` 的 `today.cacheHitTokens` 增长 |

---

## 五、约束达成对照

| 硬性约束 | 达成方式 |
|---|---|
| 新开窗口基于现有仓库源码工作，禁止脑补 | 全部基于审计结论实现，测试发现 402 分类缺陷并修复（非脑补） |
| 心智本体业务代码禁止修改 | innerTick.ts / server/life 的 TICK / 自我反思模块零改动；路由全部在 providers.ts 汇聚点外置执行；唯一触发点改动是 idle_brain 的 Phase3 特性胶水块（受配置开关控制） |
| 核心心智强制 deepseek-v4-pro，绝不让 flash 推演 | `CORE_MIND_SCENES` 硬规则 + `resolveRoute` 无条件改写；`shouldFallbackToFlash('inner_tick')` 恒 false |
| flash 仅外围输出 | peripheral 场景仅 deepseek 服务商改写 flash；其他服务商保持原模型 |
| 全部配置有 Web 设置入口 | Settings.tsx「DeepSeek 心智路由」区（总开关/模型×2/预算/告警比例/空闲间隔/状态展示/今日用量/手动唤醒按钮） |
| iPhone 复用服务端配置 | 配置/预算/频率全部存服务端 db.settings，无客户端新增设置 |
| 禁止心智自主选模型 | 无任何模型自选逻辑，全部分发由路由硬规则执行 |
| 编译校验 tsc --noEmit 通过 | ✅ 0 错误 |
| 输出最终标记 | 【DEEPSEEK-ROUTER-DONE】 |
