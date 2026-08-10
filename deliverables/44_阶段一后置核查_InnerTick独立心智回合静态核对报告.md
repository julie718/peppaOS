# Phase1 核查报告

核查时间：2026-08-10 ｜ 核查方式：纯静态源码分析（仅读盘，零修改） ｜ 基准：工作区磁盘现有文件

**总体结论：【通过】**

全部 7 项核查通过：旧 life 状态机完整保留且未被业务调用 InnerTick；Phase1 三份产出文件齐全且符合边界承诺（快照仅渲染 prompt、addMemory 全量过守卫、输出写回 life.db 快照备份、不修改全局运行状态）；chat 主链路零引入；`tsc --noEmit` 退出码 0。

---

## 1. server/life/index.ts 旧状态机保护

结果：**✅ 通过**

- TICK 定时器完整存在：`TICK_INTERVAL_MS = 10 * 60000`（[server/life/index.ts:44](server/life/index.ts#L44)）；`start()` 内 `setInterval` 每 10 分钟执行 `tick()`（[server/life/index.ts:193-195](server/life/index.ts#L193-L195)）；`stop()` 正常 `clearInterval`（[server/life/index.ts:199-208](server/life/index.ts#L199-L208)）。无删除、无整块注释。
- 旧业务全套保留（`tick()` 步骤链 [server/life/index.ts:380-555](server/life/index.ts#L380-L555)）：
  - 情绪衰减：`emotions.tickEmotions()`（[server/life/index.ts:392](server/life/index.ts#L392)）
  - 欲望生成与衰减：`desires.generateDesires()` + `desires.tick()`（[server/life/index.ts:402-405](server/life/index.ts#L402-L405)）
  - 人格演化：每 10 次交互聚合微调（[server/life/index.ts:424-437](server/life/index.ts#L424-L437)）
  - 关系衰减（[server/life/index.ts:420-422](server/life/index.ts#L420-L422)）、自我反思（[server/life/index.ts:440-442](server/life/index.ts#L440-L442)）、自主探索（[server/life/index.ts:221-299](server/life/index.ts#L221-L299)）、低优先级任务（[server/life/index.ts:302-377](server/life/index.ts#L302-L377)）、记忆GC、叙事、闸门心跳等均未受影响。
- 本阶段**没有**新增业务调用 InnerTick：life/index.ts 内 0 处 InnerTick 引用；全局 `runInnerTick` 扫描见 §6，业务文件零调用。旧状态机独立运行。

## 2. Phase1产出文件

### src/types/innerTickSchema.ts
- 文件存在：**是**（54 行）
- schema 完整性：**✅ 通过** — `InnerTickOutput` 含全部 8 项字段（[innerTickSchema.ts:45-54](src/types/innerTickSchema.ts#L45-L54)）：`thought`、`mood{name,intensity}`、`desires{id,content,intensity,status}`、`goals{id,content,status}`、`focus{id,content}`、`archiveItems{type,id,reason}`、`triggerInnerTick`、`memoryHints`。
- 约束：uuid v4、intensity 0-1 在类型注释声明（[innerTickSchema.ts:3,9,14,16](src/types/innerTickSchema.ts#L3)），并在实现层强制（innerTick.ts `UUID_V4_RE` [src/core/innerTick.ts:40](src/core/innerTick.ts#L40)、`clamp01` [src/core/innerTick.ts:212-216](src/core/innerTick.ts#L212-L216)、`validUuidOrNew` [src/core/innerTick.ts:222-225](src/core/innerTick.ts#L222-L225)）。

### src/core/innerTick.ts
- 文件存在：**是**（409 行）
- 快照读取：**仅用于 prompt 渲染** — `loadLifeSnapshotAsText()` 返回拼接文本字符串（[innerTick.ts:59-144](src/core/innerTick.ts#L59-L144)），`runInnerTick` 中仅 `const snapshotText = await loadLifeSnapshotAsText()` 后传入 `buildInnerTickSystemPrompt`（[innerTick.ts:373-374](src/core/innerTick.ts#L373-L374)）。全文件无任何"快照对象赋值给运行时状态变量"的操作，不存在复用风险。
- 内置 System Prompt：**完整** — 心智推演/欲望衰减/生成新欲望（[innerTick.ts:163-164](src/core/innerTick.ts#L163-L164)）、archiveItems 归档（[innerTick.ts:166](src/core/innerTick.ts#L166)）、严格 JSON 输出约束（[innerTick.ts:167](src/core/innerTick.ts#L167)）、schema 规格（[innerTick.ts:150-160](src/core/innerTick.ts#L150-L160)）。
- LLM JSON 容错：**存在** — `parseInnerTickJson` 剥代码围栏、截取首个 `{...}` 完整块、尾逗号二次解析（[innerTick.ts:180-206](src/core/innerTick.ts#L180-L206)）。
- archiveItems 归档逻辑：**完整** — `processArchives` 每条归档先过守卫、写向量记忆、随后从本次输出的 active desires/goals 列表移除（[innerTick.ts:300-340](src/core/innerTick.ts#L300-L340)，移除动作 [innerTick.ts:335-338](src/core/innerTick.ts#L335-L338)）。
- addMemory 经过 guardIllegalAddMemory：**是** — import（[innerTick.ts:16](src/core/innerTick.ts#L16)），全文件唯一 addMemory 调用点（[innerTick.ts:314](src/core/innerTick.ts#L314)）紧随守卫调用（[innerTick.ts:304](src/core/innerTick.ts#L304)）之后。
- 写 life.db 快照备份：**是** — `persistSnapshot` 经 `logSystemEvent` 写入 `system_events` 表（[innerTick.ts:346-358](src/core/innerTick.ts#L346-L358)；lifeDb.ts 落库语句 `INSERT INTO system_events` [server/db/lifeDb.ts:643-645](server/db/lifeDb.ts#L643-L645)），事件类型 `inner_tick_snapshot`（[innerTick.ts:43](src/core/innerTick.ts#L43)）。
- runInnerTick 导出：**存在** — `export async function runInnerTick(): Promise<InnerTickOutput>`（[innerTick.ts:368](src/core/innerTick.ts#L368)）。
- 是否修改全局运行状态：**否（合规）** — runInnerTick 仅读 lifeDb（getter 族）、写快照 event、写归档记忆（Phase1 规范允许的归档语义）；未 import 或触碰 LifeSystem 任何全局状态，无全局变量写入。

### src/test/runInnerTickDemo.ts
- 文件存在：**是**（58 行）
- 是否仅用于调试、未接入业务：**✅ 通过** — 独立 `main()` 仅调用 `runInnerTick` 并打印全部输出字段（[runInnerTickDemo.ts:25-49](src/test/runInnerTickDemo.ts#L25-L49)）；依赖仅 `runInnerTick` + `initDatabase`（[runInnerTickDemo.ts:7-9](src/test/runInnerTickDemo.ts#L7-L9)）；无任何 chat / 业务模块 import；运行方式注释明确为手动调试脚本（[runInnerTickDemo.ts:3](src/test/runInnerTickDemo.ts#L3)）。

## 3. 日志埋点

结果：**完整 ✅**

| 埋点 | 位置 |
|---|---|
| `[InnerTick-Phase1] 心智回合开始` | [src/core/innerTick.ts:369](src/core/innerTick.ts#L369) |
| `[InnerTick-Phase1] 心智回合结束 (desires=... goals=... archived=...)` | [src/core/innerTick.ts:407](src/core/innerTick.ts#L407) |
| 归档动作日志 `归档动作: type=... id=... reason=...` | [src/core/innerTick.ts:326](src/core/innerTick.ts#L326) |
| JSON 解析失败错误日志 `JSON解析失败: ...` | [src/core/innerTick.ts:204](src/core/innerTick.ts#L204) |

另有快照写入成功/失败、各快照源读取失败 warn（[innerTick.ts:68,77,90,99,108,117,126,140,352,355](src/core/innerTick.ts#L68)），异常路径覆盖充分。

## 4. 业务链路隔离检查（高优先级）

结果：**✅ 通过**

- chat.ts 引入/调用 runInnerTick：**无** — `grep -n "innerTick|InnerTick" server/socket/chat.ts` 零匹配（[server/socket/chat.ts](server/socket/chat.ts)，2162 行全文无 InnerTick 字样）。
- 全局 runInnerTick 调用清单（全仓库扫描）：
  - [src/core/innerTick.ts:368](src/core/innerTick.ts#L368) — 定义/导出（合法）
  - [src/test/runInnerTickDemo.ts:7](src/test/runInnerTickDemo.ts#L7) — import（合法）
  - [src/test/runInnerTickDemo.ts:25](src/test/runInnerTickDemo.ts#L25) — 调用（合法，唯一调用点）
- server/scheduler.ts、server/autonomy/idle_brain.ts（注：实际路径为 autonomy 目录，非 socket/）及 server/ 全目录：**0 处** InnerTick 引用。**无违规调用。**

## 5. paradigmGuard 守卫校验

结果：**✅ 通过**

- 导入：`import { guardIllegalAddMemory } from '../utils/paradigmGuard'`（[innerTick.ts:16](src/core/innerTick.ts#L16)）
- 调用：`processArchives` 循环内每次归档前调用（[innerTick.ts:304](src/core/innerTick.ts#L304)）
- 覆盖性：innerTick.ts 内 **唯一** addMemory 调用点（[innerTick.ts:314](src/core/innerTick.ts#L314)）位于守卫调用之后，全量覆盖 ✅
- 守卫白名单已含 InnerTick 栈匹配 `[/InnerTick|inner_tick/i]`（[src/utils/paradigmGuard.ts:84](src/utils/paradigmGuard.ts#L84)），守卫调用信息串 `InnerTick(Phase1)...` 可命中白名单 → 静默通过，无范式告警。

## 6. 全局扫描清单

#### runInnerTick
- [src/core/innerTick.ts:368](src/core/innerTick.ts#L368)（导出定义）
- [src/test/runInnerTickDemo.ts:7](src/test/runInnerTickDemo.ts#L7)（import）
- [src/test/runInnerTickDemo.ts:25](src/test/runInnerTickDemo.ts#L25)（唯一调用）

#### InnerTickOutput
- [src/types/innerTickSchema.ts:45](src/types/innerTickSchema.ts#L45)（接口定义）
- [src/core/innerTick.ts:31](src/core/innerTick.ts#L31)（type import）
- [src/core/innerTick.ts:227](src/core/innerTick.ts#L227)（normalizeOutput 返回类型）
- [src/core/innerTick.ts:300](src/core/innerTick.ts#L300)（processArchives 参数）
- [src/core/innerTick.ts:346](src/core/innerTick.ts#L346)（persistSnapshot 参数）
- [src/core/innerTick.ts:368](src/core/innerTick.ts#L368)（runInnerTick 返回类型）
- [src/core/innerTick.ts:385](src/core/innerTick.ts#L385)（局部变量）
- [src/test/runInnerTickDemo.ts:27](src/test/runInnerTickDemo.ts#L27)（console 标签）

#### innerTick.ts 内部 addMemory(
- [src/core/innerTick.ts:314](src/core/innerTick.ts#L314)（唯一调用点，位于守卫 [innerTick.ts:304](src/core/innerTick.ts#L304) 之后）

#### innerTick.ts life.db read/write
- read（lifeDb getter 族，仅渲染 prompt）：getPersonality [innerTick.ts:63](src/core/innerTick.ts#L63)、getRecentEmotions [innerTick.ts:72](src/core/innerTick.ts#L72)、getActiveDesires [innerTick.ts:81](src/core/innerTick.ts#L81)、getTopDesire [innerTick.ts:85](src/core/innerTick.ts#L85)、getRecentReflections [innerTick.ts:94](src/core/innerTick.ts#L94)、getSignificantMemories [innerTick.ts:103](src/core/innerTick.ts#L103)、getLatestRelationship [innerTick.ts:112](src/core/innerTick.ts#L112)、getUnresolvedThoughts [innerTick.ts:121](src/core/innerTick.ts#L121)、getRecentEvents [innerTick.ts:131](src/core/innerTick.ts#L131)
- write：logSystemEvent 快照落库 [innerTick.ts:348](src/core/innerTick.ts#L348)（→ server/db/lifeDb.ts:645 `INSERT INTO system_events`）

## 7. tsc --noEmit

退出码：**0**（无类型错误）

---

## ⚠️ 风险与待人工复核清单

1. **向量记忆写入的边界语义**（低风险，建议确认）：`processArchives` 经守卫写入向量记忆（[innerTick.ts:314-325](src/core/innerTick.ts#L314-L325)）属 Phase1 规范明确允许的"归档写入"；但该写入发生在快照落库之前，若 addMemory 抛错已 try/catch 不阻断（[innerTick.ts:327-329](src/core/innerTick.ts#L327-L329)）。人工确认"不修改全局运行状态"边界是否把 addMemory 写入视作预期行为即可（按规范语义应为预期）。
2. **paradigmGuard 注释与现状轻微不同步**（不影响功能）：[src/utils/paradigmGuard.ts:66](src/utils/paradigmGuard.ts#L66)、[83](src/utils/paradigmGuard.ts#L83) 注释仍写"阶段 1 尚未实现，预留点位"，但 Phase1 已实现且白名单正则实际生效（[paradigmGuard.ts:84](src/utils/paradigmGuard.ts#L84)）。建议后续阶段顺手更新注释，非缺陷。
3. **上一轮快照连续性素材依赖排序**（设计权衡）：[innerTick.ts:131-132](src/core/innerTick.ts#L131-L132) 用 `getRecentEvents(50)` 查找历史 `inner_tick_snapshot`，若 system_events 总量大且该事件久远则取不到；只影响 prompt 素材连续性，不影响正确性。
4. **未与 git HEAD 差异对比**：本次核查完全基于工作区磁盘当前内容（git status 显示 server/life/index.ts、chat.ts 等存在未提交修改）。未对改动做 diff 溯源，如需审计"本阶段引入的变更边界"请结合 [41_全阶段核验_Git变更边界审计报告.md](41_全阶段核验_Git变更边界审计报告.md) 交叉复核。
5. **runInnerTick 失败语义**：LLM 推演失败直接向上抛（[innerTick.ts:396-399](src/core/innerTick.ts#L396-L399)），当前唯一调用方 demo 已捕获处理；若未来接入定时/主链路，需自行补错误策略（阶段2 事项，不属本次范围）。
