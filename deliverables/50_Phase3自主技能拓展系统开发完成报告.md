# Phase3 自主技能拓展系统 — 开发完成报告

- 日期：2026-08-12
- 分支：main（未提交工作区）
- 基线：Phase0/Phase1/Phase2 全部核查与偏差修正完成；p2MigrateEnable=true；paradigmGuard 完整保留；旧 life 状态机未动
- 验证：`npx tsc --noEmit` → **EXIT=0**（零类型错误）

---

## 一、交付总览

Phase3 技能拓展系统分两层交付：

1. **既有底座（commit 484933e 已交付并挂载）**：六大模块（检索评估 / 缺口识别 / 外部适配 / 沙箱自研 / 测试审批 / 监控自修复）+ 独立库 `skills_extension.db` 5 表 + 78/78 E2E，路由经 `server/runtime/routes.ts:51` 挂载，`ensureSkillsReady` 惰性初始化。
2. **本次补齐（spec 差距闭环，全部纯新增）**：
   - 总开关 `PEPPA_PHASE3_SKILL_AUTO_ENABLE`（一键关闭整套 Phase3）＋ 熔断/风险/日志配置
   - `mcp_skill_store` 独立数据表（元数据 / 来源 / 风险标记 / 成功率统计）
   - 单会话新增工具数量熔断 ＋ 全局限额熔断
   - 风险分级（高风险拦截 / 中风险告警）在检索、适配、升级、沙箱生成、审批上线全链路口径一致
   - innerTick 心智技能决策维度（需要工具 / 成熟MCP / 复用|修改|自研）→ `skill_decision` 心智事件
   - 技能生命周期管理（安装 / 启用 / 禁用 / 卸载）＋ 成功率统计同步
   - 结构化事件日志（检索 / 评估 / 安装 / 生成 / 调用 / 卸载 每次动作一条 JSON）

---

## 二、新增文件清单（5 个）

| 文件 | 关键行号 | 职责 |
|---|---|---|
| `server/skills_extension/switch.ts` | `Phase3Config` L8；`loadPhase3Config` L34；`isPhase3Enabled` L55；`logSkillEvent` L77 | 全模块唯一配置源：总开关 / 熔断阈值 / 风险策略 / 结构化日志；`[SkillsEvent]` JSON 事件行 |
| `server/skills_extension/risk_policy.ts` | `HIGH_RISK_MARKERS` L24；`isHighRiskCommunityHit` L41；`classifyRisk` L51；`assertDeployAllowed` L76 | 风险分级（safe/medium/high，确定性规则）；部署闸门（strict=高风险拦截 + 中风险告警，warn=仅告警） |
| `server/skills_extension/breakers.ts` | `checkSessionSlot` L19；`consumeSessionSlot` L37；`assertGlobalCap` L54；`getBreakerStatus` L68 | 单会话窗口熔断（内存）+ 全局限额熔断（DB 持久计数）；命中输出 `breach` 事件 |
| `server/skills_extension/mind_decision.ts` | `SkillConclusion` L18；`decideSkillForTask` L47；`emitSkillDecisionToMind` L91 | innerTick 技能决策三维度；结论优先级锁定 reuse > modify > self_build；`skill_decision` 心智事件经 runInnerTick 落库 |
| `server/skills_extension/lifecycle.ts` | `installSkill` L29；`setSkillStatus` L58；`recordSkillCall` L76；`syncCallStatsFromMonitoring` L92 | mcp_skill_store 生命周期（安装/启用/禁用/卸载）+ 成功率统计回写与同步 |

## 三、修改文件清单（9 个，全部为追加式改动，未删除/重构任何既有逻辑）

| 文件 | 关键位置 | 改动 |
|---|---|---|
| `server/skills_extension/database.ts` | `mcp_skill_store` 表 L115；CRUD L389-456 | 第 6 张独立表（幂等迁移）；upsert / 查询 / 计数 / 状态变更 / 统计回写 |
| `server/skills_extension/types.ts` | `SkillStoreSource` / `SkillStoreEntry` | 技能库类型定义（追加） |
| `server/skills_extension/index.ts` | L30 / L45 / L60 | 初始化与巡检挂总开关门；新增 10 分钟成功率统计同步巡检 |
| `server/skills_extension/routes.ts` | L33 开关门；L301-363 新端点 | 总开关关闭时仅挂 `/skills/status`；新增 `/skills/config`、`/skills/store`、`/skills/store/:tool/{enable,disable,uninstall}`、`/skills/decision` |
| `server/skills_extension/adapter.ts` | L252 升级闸门；L318+ 安装登记；L415+ 适配闸门+熔断 | 适配暂存 / 版本升级走风险闸门；适配消耗单会话名额；首次上线自动登记 mcp_skill_store（sandbox→self_build） |
| `server/skills_extension/sandbox.ts` | L64-73 | AI 自主生成同样走风险闸门 + 单会话熔断（可选 sessionId 入参，签名兼容） |
| `server/skills_extension/search_engine.ts` | L157-162 | 社区检索基础过滤：高风险标记（恶意/后门/凭证窃取）命中即剔除，附审计 |
| `server/skills_extension/approval.ts` | L77-81 | 审批上线前全局限额熔断检查 |
| `server/skills_extension/hooks.ts` | L105 | 月度缺口复评改用 `decideSkillForTask`（心智技能决策维度接入例行链路） |
| `.env.example` | L47-59 | Phase3 开关与熔断配置说明 |
| `docker-compose.yml` | L36-42 | Phase3 环境变量透传（默认值对齐 .env.example） |

## 四、开关说明（全部环境变量，默认与任务指令一致）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PEPPA_PHASE3_SKILL_AUTO_ENABLE` | `true` | **总开关**：false = 一键关闭整套 Phase3。初始化跳过（含建表）、巡检不启动、路由只留只读状态端点、各入口（适配/沙箱/审批）随配置失效 |
| `PEPPA_PHASE3_MAX_TOOLS_PER_SESSION` | `10` | 单会话熔断窗口内最大新增工具数量（暂存适配 + 沙箱生成合计） |
| `PEPPA_PHASE3_BREAKER_WINDOW_MINUTES` | `60` | 熔断统计窗口（分钟） |
| `PEPPA_PHASE3_GLOBAL_MAX_TOOLS` | `30` | 全局限额：mcp_skill_store 累计安装上限（DB 持久计数，跨重启有效） |
| `PEPPA_PHASE3_RISK_POLICY` | `strict` | `strict`：高风险直接拦截部署、中风险日志告警；`warn`：全部放行仅告警 |
| `PEPPA_PHASE3_STRUCTURED_LOG` | `true` | 结构化事件日志开关 |

## 五、熔断规则说明

1. **单会话熔断（内存窗口）**：`breakers.consumeSessionSlot(sessionId)` — 每暂存一次适配 / 生成一个沙箱项目消耗 1 个名额；窗口内达到 `PEPPA_PHASE3_MAX_TOOLS_PER_SESSION` 后拒绝继续创建，返回明确拦截文案并输出 `breach` 事件日志。窗口按 `breakerWindowMinutes` 滑动重置。
2. **全局限额（DB 持久）**：`breakers.assertGlobalCap()` — 以 `mcp_skill_store` 中 `status != 'uninstalled'` 行数为准；审批上线（`approval.decideApproval`）与安装登记（`lifecycle.installSkill`）双重校验，跨重启有效。
3. **熔断语义**：拒绝而非降级——工具池、旧 life 状态机、主聊天链路完全不受影响（模块与 chat 零耦合，见第八节）。

## 六、风险分级规则说明

- **high（直接拦截，禁止部署）**：显式 `securityLevel='high'`，或来源文本（仓库名/描述/接口地址）命中 `HIGH_RISK_MARKERS`（exploit / backdoor / keylogger / credential dump / 木马 / 远控 / 注入 / 免杀 等双语言标记）。
- **medium（放行但告警记录）**：需外部密钥且未声明合规域；社区来源且无可追溯来源信息。
- **safe**：其余。
- 拦截点全覆盖：检索阶段过滤社区命中（`search_engine`）→ 适配暂存与版本升级（`adapter`）→ AI 沙箱生成（`sandbox`）→ 审批上线全局校验（`approval`）。
- 每次非 safe 判定输出 `risk_assess` 事件（含分级、依据、拦截/放行结论）。

## 七、mcp_skill_store 表定义（独立库第 6 表）

```sql
CREATE TABLE IF NOT EXISTS mcp_skill_store (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL UNIQUE,        -- 工具名
  version TEXT DEFAULT '1.0.0',          -- 版本
  source TEXT NOT NULL DEFAULT 'community', -- community(社区下载)/registry(内置)/api(第三方)/self_build(AI自主生成)
  origin TEXT DEFAULT '',                -- 仓库/接口/生成来源
  risk_level TEXT DEFAULT 'safe',        -- 风险标记 safe/medium/high
  security_level TEXT DEFAULT 'safe',
  compliance_domain TEXT DEFAULT 'none',
  needs_credential INTEGER DEFAULT 0,
  status TEXT DEFAULT 'installed',       -- installed/enabled/disabled/uninstalled
  success_count INTEGER DEFAULT 0,       -- 成功率统计
  fail_count INTEGER DEFAULT 0,
  total_calls INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 1.0,
  metadata TEXT DEFAULT '{}',
  installed_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)
```

独立存放于 `skills_extension.db`（与 life.db 完全隔离），与旧业务表零混杂；成功率统计权威源为 `tool_monitoring`，巡检每 10 分钟聚合同步一次。

## 八、异常兜底说明（技能模块崩溃不击穿主聊天链路）

- **零耦合**：`server/socket/chat.ts` 及全部 socket 模块对 `skills_extension` 无任何引用（已全局 grep 验证）；技能模块崩溃在物理上无法进入聊天链路。
- **初始化失败兜底**：路由挂载处 `ensureSkillsReady().catch(...)`，建表/接线失败仅告警，路由其余端点自带 try/catch。
- **巡检防崩**：全部 setInterval 回调 `.catch(() => {})` 且 `.unref()`。
- **总开关兜底**：`PEPPA_PHASE3_SKILL_AUTO_ENABLE=false` 时模块整体降级为只读状态端点。
- **心智事件兜底**：所有 runInnerTick 派发均为 fire-and-forget + 捕获告警（沿用 gap_detector 既有模式）。

## 九、硬性约束符合性

| 约束 | 符合性 |
|---|---|
| 只新增，不删除/修改/重构 Phase0-2 逻辑 | ✅ 未触碰 server/life、innerTickSchema.ts、paradigmGuard、chat.ts、db_layer 旧业务（工作区既有 Phase2 改动原样保留） |
| `tsc --noEmit` EXIT=0 | ✅ 实测 0 |
| 优先复用社区成熟技能，无成熟方案才自研 | ✅ 顶层规则锁定 reuse > modify > self_build；七维评估 <0.6 淘汰；`decidePathFromCandidates` 未改动 |
| 外部/自研 MCP 全部隔离沙箱执行 | ✅ 既有 sandbox 隔离目录 + SSRF 内嵌 + 审批闸门（未改动），本次补齐风险前置过滤 |
| 禁止无限制生成工具（成本/数量/风险熔断） | ✅ 单会话熔断 + 全局限额 + 风险分级拦截（本次新增） |
| 不接管对话主输出，心智仍走 inner_tick_snapshot | ✅ 技能决策/推理链仅以 `skill_decision` / `gap_reasoning` 心智事件注入 runInnerTick，不干预 chat 响应 |

## 十、结构化日志埋点（`[SkillsEvent]` JSON 行 + skills_audit 表）

| 事件 | 触发点 | 记录字段 |
|---|---|---|
| `search` | 检索（含高风险过滤） | 来源、候选/达标/淘汰数、决策路径 |
| `assess` | 心智技能决策 | 结论、needsTool、matureMcp、注入 innerTick |
| `risk_assess` | 风险分级非 safe | 级别、依据、拦截/放行 |
| `install` | 首次上线登记 | 来源（community/self_build/…）、风险、版本 |
| `generate` | 沙箱生成（既有 sandbox_generate 审计） | 缺口、目录 |
| `call` | 调用失败回写 | 工具、来源、风险、失败累计 |
| `enable/disable/uninstall` | 生命周期变更 | 来源、风险、执行者 |
| `breach` | 熔断命中 | 会话、计数、上限 |
| `upgrade/rollback` | 版本管理（既有） | 版本轨迹 |

## 十一、tsc 验证输出

```
$ npx tsc --noEmit
（无输出）
$ echo $?
0
```

## 十二、后续说明

- 本任务按要求只做编码与静态验证，不做运行时测试；运行时验证（含 78/78 E2E 回归、真实环境开关切换）交由 Phase3 独立静态核查指令。
- 工作区同时存在 Phase2 未提交改动（DeepSeek 路由 / llm_router_calls / innerTickAdapter / Settings 等），与本次改动互不交叉，未做任何处理。
