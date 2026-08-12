# PeppaOS（May-OS）Phase0–Phase3 项目归档总结报告

> **重要声明：本报告为静态源码审计结果**。全部结论基于只读代码审查（未修改任何代码）、`tsc --noEmit` 编译基线校验（EXIT=0 通过）与存量交付文档核对，**未执行任何运行时测试**。运行正确性依赖 NAS 真机验证（见第 7 章手动验证清单）。

- 审计日期：2026-08-12
- 审计基线：仓库 main 分支工作区当前状态（含未提交改动，见第 5.2 节 git 治理提示）
- 审计方式：4 路并行探索代理 + 核心文件逐行亲读（Phase3 全部关键模块、P2 心智迁移全部关键模块、部署配置、3 份关键交付文档）
- 适用范围：NAS Docker 部署（qweasd.top，容器名 peppaos）参考归档

---

## 1. 项目总述：数字生命体 PeppaOS 各阶段目标与设计初衷

### 1.1 项目定位

PeppaOS（曾用名 LumiOS）是一个**数字生命体操作系统**：TypeScript + Node.js（Express）+ React + Vite + SQLite + Docker，fork 自 PeppaOS（2026-07-05）。目标不是"聊天机器人"，而是一个拥有**独立心智回合、记忆分层、人格演化、欲望驱动、情绪状态、自主技能拓展**的长期驻留数字生命体——部署于 NAS 持续运行，桌面端（Tauri）与移动端（Capacitor）为交互外壳。

### 1.2 两套阶段命名体系（务必先澄清）

仓库存在**两套并行的阶段命名**，归档查阅时需注意区分：

| 命名体系 | 对应内容 | 典型文档/交付物 |
|---|---|---|
| **阶段一 / 阶段二 / 阶段三**（交付验收线） | 阶段一：标准 MCP 工具箱 + 数字孪生 + PSI 动机引擎；阶段二：自诊疗 self-heal；阶段三：自主技能拓展系统 | 33/34 号终验报告、39 号三套 E2E 回归 |
| **Phase1 / Phase2 / Phase3**（心智演进线） | Phase1：InnerTick 独立心智回合；Phase2：P2 心智迁移（写库范式守卫）；Phase3：自主技能拓展（= 阶段三） | PHASE2_DEVIATION.md、44 号静态核对报告、50 号开发完成报告 |

本文档以"阶段 X（交付验收线）+ Phase N（心智演进线）"双标注方式引用。

### 1.3 各阶段目标与设计初衷

| 阶段 | 设计初衷（为什么做） | 核心目标（做成什么） |
|---|---|---|
| **阶段一** | 数字生命体需要"能做事的手"：标准工具能力 + 自主任务执行底座 | 5 套标准 MCP（21 工具）+ 数字孪生（digital_twin）+ PSI 动机引擎 + 多路径推理（orchestrator/background delegation），E2E 124/124 → 模板清理后 149/149 |
| **阶段二** | 长期驻留系统必须有自诊疗能力，故障不能总等人修 | self-heal 自诊疗模块（10 文件，73 断言 SH-A001~A073），健康评分机制（基线 60/degraded），验收 36/36 |
| **Phase1** | 原 TICK 循环是"代码公式模拟心智"（零 LLM 决策），需要真正的心智回合 | InnerTick 独立心智回合（874 行）：LLM 读状态投影 → 心智自主输出 → inner_tick_snapshot 观测表落库 |
| **Phase2** | InnerTick 与传统 TICK 双写 life.db 心智表会造成数据冲突与范式撕裂 | P2 心智迁移：范式守卫拦截旧 TICK 写心智表，仅 InnerTick 调用栈可写；旧 TICK 降级只读快照观测；灰度开关 p2MigrateEnable=true |
| **阶段三 / Phase3** | 数字生命体应能自主拓展技能（缺口感知 → 社区 MCP → 自研生成），但 AI 生成代码直接进本体等于自杀 | 自主技能拓展系统：社区 MCP 优先 / 进程级沙箱隔离（方案A）/ 风险分级+审批 / 双维熔断 / 监控自愈 / 总开关隔离 |

三阶段验收合计 **263/263 E2E 全绿**（阶段一 149 + 阶段二 36 + 阶段三 78）；另有 vitest 全量基线（226 passed / 9 failed，9 个为改动前既有基线失败，独立 worktree 实证）。

---

## 2. 分阶段交付清单

### 2.1 阶段一（交付验收线）：标准工具 + 自主任务底座

- **核心目标**：建立数字生命体的"工具手"与"任务脑"。
- **已完成能力**：
  - 5 套标准 MCP：`travel-cal-mcp` / `web-search-mcp` / `stock-fin-mcp` / `notify-mcp` / `util-mcp`（21 工具），双形态注册（ToolRegistry 直调 + createXxxMcpServer 外部挂载，`server/tools/mcp_servers/`）
  - 数字孪生 digital_twin + PSI 动机引擎（server/autonomy/）：任务生成/任务队列/任务执行闭环
  - 多路径推理：orchestrator 子 Agent 编排 + 后台委派（Path A/B/C 三分流）
  - 记忆分层体系（server/memory/ 17 文件）：episodic/internalized/growth/core_identity 四级 + 防火墙 + GC
  - 模板清理：净删 4,441 行非必要固化模板
- **验收**：E2E 124/124 → 模板清理后 **149/149**
- **关键文件**：`server/tools/mcp_servers/*`、`server/autonomy/*`、`server/agents/orchestrator.ts`、`server/memory/*`、`server/socket/chat.ts`

### 2.2 Phase1（心智演进线）：InnerTick 独立心智回合

- **核心目标**：把"代码公式模拟的心智"升级为"LLM 参与决策的心智回合"。
- **已完成能力**：
  - `src/core/innerTick.ts`（874 行）：独立心智回合主流程
  - **LLM 超时防护**：AbortController + signal 透传（`mindSwitch.innerTickLLMTimeoutMs=45000`），失败分类 `InnerTickLLMFailureKind = llm_timeout / reasoning_only / empty_content / parse_error / unknown`（L81）
  - **reasoning_only 异常处理**：content 空但 reasoningContent 有的 DeepSeek 偶发形态（L800-804）
  - **零写入兜底**：buildFallbackInnerTickOutput（triggerInnerTick=false + 空欲望 + 占位 thought），异常分支不污染心智库
  - `inner_tick_snapshot` 观测表（server/db/lifeDb.ts）：id/session_id/user_uid/turn_index/created_at/inner_output/trigger_source（CHECK chat_turn|manual）
  - 对话回合触发：`server/socket/innerTickAdapter.ts`（304 行），PEPPA_INNER_TICK_ENABLE 默认 true 仅管控 chat_turn 触发源；四段 token 预算（本轮 500 / 工作记忆 1000·最近 6 对 / 归档 700·摘要+偏好≤12 / 总 2200）；triggerInnerTickAfterChatRound fire-and-forget
- **偏差/妥协**：无独立偏差文档；本轮为"观测先行"设计——先落 inner_tick_snapshot 观测，不直接接管写库
- **关键文件**：`src/core/innerTick.ts`、`src/config/mindSwitch.ts`、`server/socket/innerTickAdapter.ts`、`server/db/lifeDb.ts`、`src/utils/paradigmGuard.ts`

### 2.3 阶段二（交付验收线）：自诊疗 self-heal

- **核心目标**：系统故障自发现、自诊断、自修复。
- **已完成能力**：`server/self_heal/`（10 文件），73 断言 SH-A001~A073；健康评分机制（基线 60/degraded）；`/api/system/health-check` 端点
- **验收**：36/36
- **关键文件**：`server/self_heal/*`、`server/self_heal/routes.ts`

### 2.4 Phase2（心智演进线）：P2 心智迁移

- **核心目标**：解决 InnerTick 与旧 TICK 对 life.db 心智表（emotions/emotion_state/desires/personality/relationship_state）的**双写冲突与范式撕裂**——统一心智写库入口。
- **已完成能力**：
  - **范式守卫 guardP2MentalStateWrite**（src/utils/paradigmGuard.ts L233-246）：`P2_GUARDED_MENTAL_STATE_TABLES = {emotions, emotion_state, desires, personality, relationship_state}`；`p2MigrateEnable=false` 时恒放行（完全回退）；`true` 时调用栈含 `/innerTick/i` 才放行，其余拦截并输出 `[P2-MIGRATE]` 告警
  - **灰度状态**：`p2MigrateEnable=true` 已灰度开启（src/config/mindSwitch.ts）；旧 TICK 降级为只读快照观测
  - **守卫体系扩展**：paradigmGuard.ts 共 6 个守卫（guardMentalStateWrite / guardIllegalAddMemory / assertNoAutoSpawnWorker / guardInnerTickLifeOverwrite / guardSessionMindPersist / guardP2MentalStateWrite），60s 节流，生产仅日志不阻断
  - **P2 落库统一**：innerTick.applyMentalDriftToBusinessState（L682-720）4 类心智漂移（emotion_drift→emotions / desire_evolve→desires 内容精确匹配去重 L613-615 / personality_drift delta±0.02 钳制 / relationship_adjustment）
  - **lifeDb p2GuardAllow 埋点**：11 个写函数（updatePersonality/addEmotion/decayEmotions/saveEmotionVector/addDesire/updateDesirePriority/updateDesireStatus/completeDesire/abandonDesire/decayDesires/saveRelationshipVector）
  - **会话心智注入**：`server/llm/sessionMindProvider.ts`（208 行）A 模式（旧 life 快照）/B 模式（inner_tick 快照），白名单总闸（`conv_45e5748b-6ed2-4c35-b789-bb2156362f2e`），四级兜底降级（快照缺失/JSON 损坏/结构校验/DB 异常），emotionVectorFromMood 8 维情绪映射
- **偏差/妥协文档**：**PHASE2_DEVIATION.md**（签署记录）：
  - p2MigrateEnable=true 保持（灰度确认）
  - PEPPA_INNER_TICK_ENABLE 仅管控 chat_turn 触发源（不控空闲触发）
  - 回退路径：p2MigrateEnable=false 零代码改动全量回退
  - tsc EXIT=0 验证通过
- **关键文件**：`src/config/mindSwitch.ts`、`src/utils/paradigmGuard.ts`、`src/core/innerTick.ts`、`server/db/lifeDb.ts`、`server/llm/sessionMindProvider.ts`、`server/socket/innerTickAdapter.ts`、`PHASE2_DEVIATION.md`、`test/p2_migrate_selftest.ts`（310 行，临时库 5 段自测）

#### 2.4.1 DeepSeek 外部强制路由（Phase2 配套交付）

- **核心目标**：心智本体强制 deepseek-v4-pro，绝不让 flash 推演；flash 仅外围输出。
- **已完成能力**（server/llm/ 4 新文件）：
  - **mindRouter.ts**：`CORE_MIND_SCENES = {inner_tick, runtime_tick, evolution, narrative, skill_gen, mcp_eval, agent_orchestrator, self_review}` 8 场景硬规则锁 pro（即使 qwen/gemini 也强制）；`shouldFallbackToFlash('inner_tick')` 恒 false（**绝不降级**）；外围仅 deepseek 服务商改写 flash
  - **budgetGate.ts**：每日 pro token 预算状态机 normal/warn/sleep；超预算抛 `BudgetSleepError`（code=BUDGET_SLEEP），只熔断 pro 核心心智；db.settings key `llm_router_daily`
  - **frequencyGate.ts**：空闲 InnerTick 最小间隔（默认 1h），豁免 chat_turn/derivedMentalEvents/目标变更
  - **routerConfig.ts**：优先级 env（DEEPSEEK_ROUTER_*）> db.settings `llm_router_config` > 默认
- **验证**：13 个自动化测试全绿（test/deepseek_router.test.ts）；vitest 全量 226 passed/9 failed——9 个为改动前既有基线失败（独立 worktree f97461f 实证，0 新增失败）
- **交付文档**：deliverables/45（含 7 条 NAS 手动验证用例，见第 7 章）

### 2.5 阶段三 / Phase3（交付验收线 = 心智演进线）：自主技能拓展系统

- **核心目标**：数字生命体自主拓展技能——感知能力缺口 → 检索社区 MCP → 无成熟方案则沙箱自研生成 → 测试 → 审批 → 部署 → 监控自愈；**AI 生成代码零进主进程**。
- **已完成能力**（`server/skills_extension/`，独立库 `skills_extension.db` 6 表）：
  - 完整闭环：搜索（search_engine）→ 评估（ToolCandidate 七维评分）→ 适配/生成（adapter 路径 A / sandbox 路径 B）→ 测试（test_pipeline）→ 审批（approval）→ 部署（lifecycle + adapter/sandbox_isolate）→ 监控自愈（monitoring）→ 审计（skills_audit + 结构化日志）
  - 25 个 REST 端点 `/api/skills/*`（status/analyze/search/adapt/sandbox/test/approvals/credentials/health-board/monthly-brief/remediate/audit/versions/cleanup/config/store/decision）
- **验收**：E2E **78/78**；三阶段合计 **263/263**
- **偏差/妥协**：无独立偏差文档；存量兼容兜底见第 5 章
- **关键文件**：`server/skills_extension/*`（16+ 文件）、`server/skills_extension/sandbox_isolate/*`（3 文件）、`server/runtime/routes.ts`（mountSkillsRoutes L51）、`deliverables/50`（开发完成报告）
- **Phase3 能力完整清单见第 3 章**（任务要求的 8 项逐条对照）

---

## 3. Phase3 能力完整清单

> 对照任务要求的 8 项硬性能力逐条核实。所有结论来自源码逐行审计。

### 3.1 复用社区 MCP 优先，无成熟方案才允许自研 MCP ✅

- **路径 A（社区优先）**：`search_engine.ts` 三级检索——① 内置注册表（6 条内置工具）→ ② 社区 GitHub API（`GITHUB_TOKEN` 可选）→ ③ 降级；`ELIGIBLE_FLOOR=0.6` 七维评估门槛，任一维度 <0.6 即淘汰（types.ts ToolCandidate）；`isHighRiskCommunityHit` 高风险社区命中过滤
- **路径 B（自研兜底）**：`sandbox.ts` 沙箱生成工坊仅在缺口评估后走，且**同受风险闸门 + 单会话熔断约束**（"AI 自主生成同样受控，禁止绕过沙箱部署高风险工具"）
- **行为对齐**：两条路径的调用结果均经同一套指标上报（setReportHook → tool_monitoring）与同一套生命周期管理（mcp_skill_store），来源标记 `community / registry / api / self_build` 四类

### 3.2 进程级沙箱隔离：AI 自研生成工具全部运行在独立子进程，本体不受破坏 ✅（方案A，P1 阻断项修复）

- **架构**：`sandbox_isolate/sandbox_host.ts`（521 行，主进程侧 IPC 代理）+ `sandbox_child.ts`（257 行，隔离子进程执行）
- **硬边界：主进程零 import 生成代码**——生成代码仅以 `file://` 形式在子进程内 import（`sandbox_child.ts` loadModule）；主进程只经 IPC 消息（invoke/describe/ssrf-probe/ping/destroy）代理调用，`createIsolatedHandler` 是唯一出口
- **资源限制**：进程池上限 3（ISOLATION_POOL_MAX）；V8 堆内存 `--max-old-space-size=256`；单次调用看门狗 45s（INVOKE_WATCHDOG_MS，宿主侧 INVOKE_TIMEOUT_MS=50s 兜底）；子进程启动超时 10s；空闲 30min TTL 回收；moduleCache 上限 64（按 (项目,源码哈希) 缓存，淘汰最旧）
- **崩溃隔离**：uncaughtException 上报后 `process.exit(1)`；宿主断开/SIGTERM 自动退出不留孤儿进程
- **编译门**：ensureSandboxBuilt（tsc 编译 → dist/index.mjs + MD5 哈希校验），哈希变则强制重载

### 3.3 完整风险分级、部署拦截、审批流程 ✅

- **风险分级**（`risk_policy.ts`）：确定性规则 classifyRisk（非 LLM 判断，双语言 HIGH_RISK_MARKERS：exploit/backdoor/credential dump/木马/远控/注入 等），输出 safe/medium/high
- **部署拦截**（assertDeployAllowed）：`strict` 策略 high 直接拦截、medium 告警；`warn` 策略全放行；`needsCredential` 与合规域参与判定；**AI 自主生成同样过此闸门**（sandbox.ts createSandboxProject 首步）
- **审批流程**（approval.ts）：submitForApproval（测试 gatePassed 门槛）→ decideApproval 三选项：`approved`（assertGlobalCap → deploySandboxTool：ensureSandboxBuilt → createIsolatedHandler → registerDefinition）/ `rejected`（必附意见，退回 building）/ `hold`；7 天未审批自动过期（SANDBOX_EXPIRE_DAYS=7，scheduler 每 6h 清理）
- **风险等级同源持久化**：创建阶段 realRiskLevel → sandbox_config.risk_level → 审批继承写入 mcp_skill_store.securityLevel（P2-2 修复，不再硬编码 'safe'）

### 3.4 会话 + 全局双维度数量熔断 ✅

- **单会话窗口**（`breakers.ts` consumeSessionSlot）：内存窗口 Map，默认 `maxToolsPerSession=10` / `breakerWindowMinutes=60`，防疯狂生成
- **全局限额**（assertGlobalCap）：DB 持久计数（skills_extension.db mcp_skill_store.countInstalledSkills），默认 `globalMaxTools=30`，重启不丢失
- 熔断触发输出 breach 事件 + 结构化日志 + 审计

### 3.5 完整监控指标、成功率统计、故障自愈：复测-回滚-下线闭环，社区/自研行为完全对齐 ✅

- **指标采集**：模板 setReportHook + 子进程 metric-report IPC（一次调用一行指标，metricReportedRequestIds 去重防双计）；adapter 路径同套 recordToolResult；recordUserNegative 记录用户负反馈
- **健康判定**（monitoring.ts）：failureRate=(errors+timeouts)/total，verdict healthy/watch/degraded；FAULT_MIN_SAMPLES=5、FAULT_RATE_THRESHOLD=0.5
- **自愈闭环**（autoRemediate）：**复测**（沙箱项目走 getIsolatedTestableTool 隔离子进程复测）→ **回滚**（listAdapterVersions ≥2 版本栈回滚）→ **下线**（toolRegistry.unregister）；reapSkillFaults 每 5 分钟巡检
- **成功率统计**：tool_monitoring 为运行指标权威源 → syncCallStatsFromMonitoring 每 10 分钟重算 → mcp_skill_store 聚合（lifecycle.ts）；月度简报 + 缺口复评（每月 3 点）
- **行为对齐**：社区路径（adapter）与自研路径（sandbox_isolate）共用同一套指标表、同一套生命周期、同一套 SSRF 规则（三处逐字一致，见 4.1）

### 3.6 完整结构化事件日志 ✅

- `logSkillEvent`（switch.ts）：**JSON 结构化事件行**（event/subject/ok/source/riskLevel/version/detail），覆盖 install/enable/disable/uninstall/call/call-ok/generate/approve/reject/breach/remediate 等全生命周期事件
- `skills_audit` 表（database.ts 第 5 表）：appendAudit 全操作审计留痕
- PEPPA_PHASE3_STRUCTURED_LOG=true 默认开启

### 3.7 Phase3 总开关：关闭完全隔离，不扰动原有系统 ✅

- **语义**（index.ts initSkillsExtension）：`PEPPA_PHASE3_SKILL_AUTO_ENABLE=false` 时——**零副作用**：跳过建库建表、巡检与路由全关闭（仅 `/skills/status` 只读端点存活）、任何 skills_extension 内部逻辑不执行
- **零耦合声明**（deliverables/50 实证）：chat.ts 无 skills_extension 引用；系统关闭时原有人工/社区 MCP 工作流完全不受影响
- **配置六维**（switch.ts Phase3Config + 6 个 env）：

| 配置项 | env | 默认 |
|---|---|---|
| 总开关 | PEPPA_PHASE3_SKILL_AUTO_ENABLE | true |
| 单会话工具上限 | PEPPA_PHASE3_MAX_TOOLS_PER_SESSION | 10 |
| 熔断窗口（分钟） | PEPPA_PHASE3_BREAKER_WINDOW_MINUTES | 60 |
| 全局限额 | PEPPA_PHASE3_GLOBAL_MAX_TOOLS | 30 |
| 风险策略 | PEPPA_PHASE3_RISK_POLICY | strict |
| 结构化日志 | PEPPA_PHASE3_STRUCTURED_LOG | true |

### 3.8 测试与质量基线 ✅

- E2E：stage3_skills_extension.test.ts 8 场景 **78/78**；stage3_acceptance.test.ts T0–T12
- 三阶段合计 263/263；vitest 全量基线 226 passed / 9 failed（既有基线失败，非本阶段引入）
- tsc --noEmit EXIT=0

---

## 4. 安全架构总览：纵深防御清单

从外层到内层逐层防御（部署态全开时）：

| 层 | 防护项 | 实现位置/参数 | 说明 |
|---|---|---|---|
| L0 进程边界 | **方案A 进程级隔离** | sandbox_host/child，fork 子进程 | 主进程零 import 生成代码；崩溃 exit(1) 不影响本体 |
| L1 网络出站 | **SSRF 守卫三处逐字一致** | mcp_template.ts（生成源码内嵌）、sandbox_child.ts（进程级 patch globalThis.fetch）、adapter.ts（社区路径） | 仅 HTTPS 公网；拦截 localhost/.local/.internal/.lan、10/127/172.16-31/192.168/169.254（含云元数据段）；**即使生成代码被改写绕过模板防护，进程边界仍拒绝内网出站** |
| L2 子进程资源 | 内存 256MB + 看门狗 45s + 启动超时 10s + 空闲 30min TTL + 模块缓存 64 | sandbox_host/child 常量 | 挂起/死循环/内存泄漏均被兜住 |
| L3 风险分级 | HIGH_RISK_MARKERS 双语言词表 + 确定性规则 | risk_policy.ts | 无 LLM 判断歧义；strict 策略 high 拦截 |
| L4 部署闸门 | assertDeployAllowed（创建阶段 + 审批阶段双闸） | sandbox.ts L66 / approval.ts | AI 自主生成与社区 MCP 同规则 |
| L5 测试流水线 | 6 类用例（功能/边界/网络降级/SSRF 真实探测/合规免责/性能稳定），MAX_TEST_ITERATIONS=5，gatePassed 全过才可审批 | test_pipeline.ts | SSRF 探测在隔离子进程内真实发起 |
| L6 人工审批 | approved/rejected/hold 三选项 + 7 天过期 | approval.ts | 高风险工具无审批不可上线 |
| L7 双维熔断 | 单会话 10/60min + 全局 30（DB 持久） | breakers.ts | 防泛滥 |
| L8 监控自愈 | 失败率阈值 0.5 → 复测→回滚→下线 | monitoring.ts | 故障工具自动出清 |
| L9 生命周期守卫 | paradigmGuard 6 守卫 + 60s 节流 | src/utils/paradigmGuard.ts | P2 心智表写库范式保护 |
| L10 心智预算 | budgetGate（每日 pro token） + frequencyGate（空闲间隔） + 强制 pro 路由 | server/llm/* | 心智推演成本与频率受控 |
| L11 数据加密 | travel-cal AES-256-GCM（密钥派生自 JWT_SECRET）、OXOG_ENV_KEY 密钥加密 | mcp_servers/travel_cal.ts、密钥库 | 敏感数据静态加密 |
| L12 供应链 | ALLOW_UNSIGNED_MCP_NPM_PACKAGES=false（默认） | docker-compose | 第三方 npm MCP 包默认禁止 |
| L13 沙箱代码自包含 | 生成源码零外部依赖、零 import 主服务模块、tsconfig types:[] | mcp_template.ts | 无供应链拖带 |
| L14 启动守卫 | JWT_SECRET 缺失 [FATAL] exit(1) | server.ts:16 | 拒绝弱配置启动 |
| L15 业务红线 | 金融/医疗强制免责声明 + 仅客观数据 | mcp_template FINANCE/MEDICAL_DISCLAIMER、stock-fin | 合规兜底 |

---

## 5. 已知范围外观察项清单

> **统一标注：以下各项均不阻断部署，纳入后续迭代处理。**

### 5.1 存量兼容兜底（已确认现状，非缺陷）

| # | 位置 | 兜底行为 | 说明 |
|---|---|---|---|
| O1 | `server/skills_extension/database.ts` | ALTER TABLE 增量补列（tool_monitoring.source、sandbox_config.risk_level）**静默忽略"列已存在"错误 = 幂等** | 兼容旧库平滑升级；缺点：错误被吞掉，难以区分"已存在"与"真失败" |
| O2 | `server/skills_extension/approval.ts` L126 | 旧沙箱项目无 risk_level 字段时回退 `'safe'` | 存量兼容；P2-2 已保证**新项目**全程真实风险等级，此兜底仅覆盖旧数据 |
| O3 | `server/skills_extension/mcp_template.ts` L45 | 模板渲染 `SECURITY_LEVEL = '${p.securityLevel || 'safe'}'` | 双保险兜底：sandbox.ts 已传入真实 realRiskLevel（与 DB 落库同源），模板侧兜底仅防御空值 |

### 5.2 git 未跟踪文件治理提示

审计发现以下新增/改动文件**尚未纳入 git 跟踪**，一旦磁盘损坏将丢失；且影响归档可追溯性：

- **交付文档**：PHASE2_DEVIATION.md、deliverables/ 下 3 份新报告（11/45/50）
- **源码**：server/llm/（mindRouter/budgetGate/frequencyGate/routerConfig 4 新文件）、server/skills_extension/ 全部新文件 + sandbox_isolate/、server/socket/innerTickAdapter.ts
- **测试**：test/deepseek_router.test.ts、p2_migrate_selftest.ts、phase3_sessionMindProvider_selftest.ts
- **大型二进制**：4 个 .bundle 文件（建议 LFS 或移出仓库）

> 处理建议：评审后 `git add` 分批提交；.bundle 大文件评估是否入 LFS/OSS。

### 5.3 文档间口径不一致观察

| 主题 | 不一致 |
|---|---|
| E2E 归属口径 | 39 号回归日志与阶段报告间存在 126+23 vs 124+25 两种拆分口径（合计一致） |
| 缺陷数 | openDefects 105 vs 120 两处记录 |
| 数据库表数 | 24+16 / 16 / 14 三种口径（life.db/peppa.db/独立库混计） |
| 阶段命名 | "阶段一/二/三"与"Phase1/2/3"两套并存（见 1.2，归档时以本报告口径为准） |

---

## 6. 部署前置检查清单（NAS Docker 部署前核对）

### 6.1 服务拓扑

| 服务 | 容器名 | 端口 | 说明 |
|---|---|---|---|
| mayos（tsx 源码模式） | peppaos | 3000 | 后端全栈；memory 4g；restart unless-stopped |
| caddy | caddy | 4043 | HTTPS 反代 → mayos:3000；Caddyfile + caddy_certs 自签证书 |

### 6.2 启动核对项（逐项打勾）

- [ ] **目录/卷**：`./data`（数据持久化）、`./server`、`./src`、`./server.ts`、`./db_layer.ts`、`./logger.ts`、`./launcher.ts`、`./routes`、`./package.json`、`./package-lock.json` 已就位（compose 源码挂载模式，**改代码无需重建镜像，需重启容器**）
- [ ] **JWT_SECRET** 已设置（缺失则 server.ts `[FATAL] exit(1)`；生产勿用 compose 默认 `change-me-in-production`）
- [ ] **LLM API Key**：至少 DEEPSEEK_API_KEY（心智主路由）；OPENAI/ANTHROPIC/GEMINI 按需
- [ ] **OXOG_ENV_KEY**（API Key 加密，`openssl rand -hex 32` 生成）
- [ ] **PEPPA_PASSWORD**（管理员登录密码，默认 peppa_2026，生产建议修改）
- [ ] **Phase3 6 个 env** 确认按需透传（总开关/熔断/风险策略/结构化日志，默认值见 3.7 表）
- [ ] **DEEPSEEK_ROUTER_* 6 个 env**（ENABLED/PRO_MODEL/FLASH_MODEL/DAILY_PRO_TOKEN_BUDGET/BUDGET_WARN_RATIO/IDLE_INNERTICK_INTERVAL_MS）确认透传；env 优先级 > Web 配置 > 默认值
- [ ] **ALLOW_UNSIGNED_MCP_NPM_PACKAGES=false**（供应链防护保持默认关闭）
- [ ] **PEPPA_INNER_TICK_ENABLE**（默认 true，仅控 chat_turn 触发源）
- [ ] **CORS_ORIGINS** 6 来源（localhost:3000 / qweasd.top:4043 / qweasd.top:3000 / capacitor://localhost / peppa.qweasd.top / qweasd.top）确认
- [ ] **p2MigrateEnable=true**（src/config/mindSwitch.ts，灰度开启态保持）
- [ ] 端口占用：3000（主服务）/ 4043（caddy）未冲突；NAS 防火墙放行
- [ ] `docker compose up -d` 后：`docker logs peppaos` 观察 bootstrap 完成（工具注册计数、Paradigm 状态日志、无 FATAL）
- [ ] **健康检查**：`GET /health` 返回 ok（Dockerfile HEALTHCHECK 同款探针）
- [ ] 双库初始化确认：`data/` 下 peppa.db / life.db / skills_extension.db 生成，无建表异常（Phase3 总开关开启时）
- [ ] 可选外挂：GPT-SoVITS（127.0.0.1:9880，需 gpt-sovits-src/venv）、mpv 播放器、Ollama/LM Studio
- [ ] 桌面端/移动端：`scripts/deploy-static.sh`（ssh 4041 → /home/ray/mayos/static，Caddy 静态承载 mobile 前端）；Tauri 桌面经 `deploy-*.sh`

---

## 7. 真机运行验证测试用例清单（NAS 部署手动验证）

> 验证方式：操作 + `docker logs peppaos` 观察。分 5 组，覆盖 Phase0–3 全链路。

### 7.1 基础健康组

| # | 验证点 | 操作 | 预期 |
|---|---|---|---|
| H1 | 服务启动 | `docker compose up -d` 后查看日志 | bootstrap 完成；工具注册计数正常；无 FATAL |
| H2 | 健康探针 | `curl http://qweasd.top:3000/health` | 返回 ok |
| H3 | 登录 | 浏览器访问 https://qweasd.top:4043，PEPPA_PASSWORD 登录 | 进入主界面；`GET /api/auth/me` 正常 |
| H4 | 双库落盘 | 检查 `data/` | peppa.db / life.db / skills_extension.db 存在且非空 |
| H5 | 标准 MCP 工具 | 对话中让 Peppa 查天气/查新闻/算数 | 对应工具被调用（日志 tool 名出现），结果正常 |

### 7.2 Phase1 InnerTick 组

| # | 验证点 | 操作 | 预期 |
|---|---|---|---|
| I1 | chat_turn 触发 | 发一条消息后看日志 | `inner_tick` LLM 调用出现（trigger_source=chat_turn） |
| I2 | 快照落库 | 查询 inner_tick_snapshot 表 | 每次聊天后有新快照行（inner_output 非空） |
| I3 | 超时兜底 | （可选）网络/模型异常时观察 | 45s 超时后无心智表写入，fallback 快照（triggerInnerTick=false） |
| I4 | 空闲闸门 | 长时间无交互（>1h）观察日志 | 空闲 InnerTick 被 frequencyGate 拦截，无 LLM 调用 |

### 7.3 Phase2 P2 心智迁移组（复用 11 号审计用例口径）

| # | 验证点 | 操作 | 预期 |
|---|---|---|---|
| P1 | 白名单会话 B 模式 | 用白名单会话（conv_45e5748b…）聊天 | 心智注入为 inner_tick 快照；新快照行生成 |
| P2 | 4 类心智落库 | 上述会话持续聊天后查库 | emotions/desires/personality/relationship_state 有增量变化（delta 均在钳制范围内） |
| P3 | TICK 降级只读 | 观察旧 TICK 运行 | 16 步零错误运行，4 张心智表零写入（只读快照观测），无 `[P2-MIGRATE]` 告警刷屏 |
| P4 | 守卫拦截验证 | 日志 grep `[P2-MIGRATE]` | 非 InnerTick 栈的心智写尝试被拦截并告警（生产仅日志不阻断） |
| P5 | 回滚路径 | （约束允许时）p2MigrateEnable=false 重启 | 旧 TICK 恢复正常写库，系统无异常 |

### 7.4 DeepSeek 强制路由组（复用 deliverables/45 手动用例 7 条）

| # | 验证点 | 操作 | 预期 |
|---|---|---|---|
| D1 | 心智强制 pro | 日志 grep `scene=inner_tick` 或 `runtime_tick` | `[LLM] ok scene=inner_tick ... model=deepseek-v4-pro`；`[LLMRouter] ok tier=core_mind` |
| D2 | 外围强制 flash | 发普通聊天 | `scene=chat ... model=deepseek-v4-flash` |
| D3 | pro 故障降级 | 临时把 DEEPSEEK_API_KEY 改错后发复杂消息 | 日志出现应急降级 flash 重试一次，消息仍回复；改回后自动回 pro |
| D4 | 预算休眠不丢数据 | Web 设置 dailyProTokenBudget 为小值 | `[BudgetGate-SLEEP]`；InnerTick 停止深度推演（记忆/人格数据保留）；`GET /api/llm/router-usage` 显示 budgetState=sleep；POST `/api/llm/router/reset-usage` 后恢复 |
| D5 | 空闲不刷 InnerTick | idleInnerTickIntervalMs 调大后长闲观察 | 空闲轮仅"频率闸门拦截"debug 日志；发消息后恢复 |
| D6 | 配置持久化 | Web 改配置保存后重启容器 | `GET /api/preferences/llm-router` 返回修改值；env 优先 |
| D7 | 缓存命中观测 | 连续两次同场景触发 | 第二次日志 cacheHitTokens>0；router-usage 的 today.cacheHitTokens 增长 |

### 7.5 Phase3 自主技能拓展组

| # | 验证点 | 操作 | 预期 |
|---|---|---|---|
| S1 | 状态端点 | `GET /api/skills/status` | 返回 enabled + 配置六维 + 各表计数 |
| S2 | 缺口分析/搜索 | `POST /api/skills/analyze` / `/search` | 返回缺口与候选（社区优先；无成熟方案才建议自研） |
| S3 | 沙箱生成+测试 | 走一次沙箱生成 | 项目状态机 building→testing（tsc ≤5 轮）；测试 gatePassed；生成目录在 sandbox_auto_mcp/ 下 |
| S4 | SSRF 真实探测 | 测试流水线 SSRF 用例 | 内网地址（10.x/127.x/169.254.x）被守卫拦截；日志可见 blocked |
| S5 | 审批流 | `POST /api/skills/approvals/.../decision` | approved → 上线（mcp_skill_store 新增，securityLevel 继承创建时 riskLevel）；rejected → 退回 building |
| S6 | 双维熔断 | 窗口内快速生成 >10 个 | 单会话熔断触发（breach 事件 + 结构化日志）；全局 >30 时 assertGlobalCap 拦截 |
| S7 | 监控+自愈 | 对已上线工具注入高失败率 | failureRate≥0.5 且样本≥5 → degraded → 复测→回滚→下线闭环；tool_monitoring/mcp_skill_store 统计同步 |
| S8 | 社区路径对齐 | 走一次社区 MCP 适配 | 与自研路径同套指标/生命周期/SSRF 规则；adapter 版本栈可回滚 |
| S9 | 总开关隔离 | PEPPA_PHASE3_SKILL_AUTO_ENABLE=false 重启 | 仅 /skills/status 存活；建表/巡检/路由全停；原系统功能不受影响 |
| S10 | 结构化日志 | 日志 grep `SKILL_EVENT` | 全生命周期 JSON 事件行（install/call-ok/generate/approve/remediate…）；skills_audit 表留痕 |

---

## 8. 后续迭代方向（贴近终极数字生命体的改进路线）

> 基线结论（deliverables/43 全模块调研审计）：**当前 PeppaOS 不是数字生命体终极方案**——它是"规则模拟的生命状态机 + LLM 装饰层"，核心决策由外层代码完成（TICK 16 步全代码公式、自主探索文案硬编码伪随机、记忆 tier 赋值代码锁定），且存在多处心智与外部状态的数据撕裂。Phase1/2/3 已实质改善（心智回合化、写库范式统一、自主技能闭环），但距终极形态仍有明确路线。结合本审计观察的补充建议如下。

### 8.1 短期（工程止血，1-2 周，低风险）

1. **git 治理与归档补全**：提交全部未跟踪源码/测试/交付文档（5.2 节）；统一文档口径（5.3 节）
2. **存量兜底收口**：database.ts ALTER 幂等兜底增加失败区分日志；approval/mcp_template 的 'safe' 兜底随旧数据自然消亡
3. **数据撕裂止血**（43 号阶段一清单）：focusStack 接通读侧注入心智、双欲望引擎合并、interactions 单一事实源、global 变量落库持久化、background_tasks 持久化、worker requestConfirmation 改 false（堵自动批准）、`[TTL:nd]` 工程标记移出记忆内容
4. **补观测**：inner_tick 触发率/预算命中/熔断事件纳入现有监控大盘（prom-client 已有）

### 8.2 中期（范式对齐，1-2 个月，中风险）

5. **TICK 心智化**：10 分钟 tick 改为"心智回合"——LLM 读状态投影后自主输出（当前感受/想做的事/优先级），代码仅执行心智决策；自主探索文案模板删除改 LLM 生成（结构化 schema 校验 + fail-safe 回退原规则）
6. **记忆生命周期上移**：复盘 LLM 输出 tier/importance（consolidateEpisodic 已开先例），GC 规则保留为兜底
7. **分流门心智化**：Path A/B 触发由"白名单+结构信号"改为 LLM 分类器综合判断
8. **打断处理心智化**：用户打断时把"正在做什么/还差什么"注入下一轮心智，由心智决定续做或放弃
9. **双模型路由扩展**：deepseek-v4-pro/flash 之外的异构模型心智适配评估（当前硬规则锁 pro 是正确兜底，但成本天花板明显——budgetGate 已是护栏，可评估 tier 化按场景选配）

### 8.3 远期（终极生命体，长期，高风险）

10. **单心智回路**：情绪/人格/关系/欲望/任务/焦点全部进心智上下文（工作记忆），life.db 退化为投影落盘；删除外部状态驱动的一切代码路径（global 变量、独立引擎、第二套存储）
11. **连续自我**：一切行为本体亲历——worker 降级为"工具"（本体在工具循环内直接调用、结果即时回流），删除后台委派模式
12. **自然记忆沉淀**：删除全部手动 addMemory 搬运点，记忆生命周期全归心智自主回顾输出
13. **上下文内宪法**：宪法约束写入 system prompt 常驻（对抗幻觉持续层），输出后置正则降级为最后兜底
14. **沙箱能力扩展**：当前沙箱仅 HTTPS JSON 适配器模板——远期支持多模态/本地数据源（需等 L1 出站策略成熟后按域扩展）、以及生成技能的"心智注册"（技能进心智上下文而非工具注册表）

**验证口径**：远期目标的代码面验收标准（43 号）——全仓库无业务代码直接调 addMemory（仅心智通道）；无 setInterval 驱动的决策路径；无规则闸门（白名单/概率/结构分级）；tick/对话/待机/工具/记忆全部出现在同一条"心智回合"日志链。

---

## 附录 A：审计证据索引（速查）

| 主题 | 位置 |
|---|---|
| Phase3 配置与结构化日志 | server/skills_extension/switch.ts |
| 风险分级/部署拦截 | server/skills_extension/risk_policy.ts |
| 双维熔断 | server/skills_extension/breakers.ts |
| 独立库 6 表 + 存量兜底 | server/skills_extension/database.ts |
| 沙箱工坊/tsc 迭代/过期 | server/skills_extension/sandbox.ts |
| 生成模板（SSRF/免责/指标钩子） | server/skills_extension/mcp_template.ts |
| 审批三选项 | server/skills_extension/approval.ts |
| 监控/自愈闭环 | server/skills_extension/monitoring.ts |
| 生命周期/成功率统计 | server/skills_extension/lifecycle.ts |
| 社区路径执行器（SSRF 三处之一） | server/skills_extension/adapter.ts |
| 三级检索 | server/skills_extension/search_engine.ts |
| 测试流水线 | server/skills_extension/test_pipeline.ts |
| 25 个 REST 端点 | server/skills_extension/routes.ts |
| 方案A 隔离（主进程侧） | server/skills_extension/sandbox_isolate/sandbox_host.ts |
| 方案A 隔离（子进程侧） | server/skills_extension/sandbox_isolate/sandbox_child.ts |
| P2 范式守卫 6 守卫 | src/utils/paradigmGuard.ts |
| 灰度开关 | src/config/mindSwitch.ts |
| InnerTick 874 行 | src/core/innerTick.ts |
| 会话心智注入 A/B 模式 | server/llm/sessionMindProvider.ts |
| 强制路由（pro 硬锁/flash 外围） | server/llm/mindRouter.ts |
| 预算闸 | server/llm/budgetGate.ts |
| 频率闸 | server/llm/frequencyGate.ts |
| 路由配置优先级 | server/llm/routerConfig.ts |
| life.db 心智库 + inner_tick_snapshot | server/db/lifeDb.ts |
| 路由挂载 | server/runtime/routes.ts |
| 部署配置 | docker-compose.yml / .env.example / Caddyfile |
| 5 套标准 MCP | server/tools/mcp_servers/* |
| 工具注册表（42 注册函数） | server/tools/definitions/index.ts |
| 测试基线 | test/*.test.ts（38 文件）、stage3_*.test.ts、p2_migrate_selftest.ts |
| 偏差签署 | PHASE2_DEVIATION.md |
| 演进路线 | deliverables/43 |

---

*报告结束。本报告为静态源码审计结果，运行正确性依赖 NAS 真机验证（第 7 章清单）。*
