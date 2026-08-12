# PHASE2_DEVIATION — 偏差签署记录

> 签署对象：Phase2 双轨并行契约偏差
> 签署日期：2026-08-12
> 签署范围：P2 心智迁移灰度实验期间的运行行为偏差声明（仅文档签署，不涉及代码行为变更）

## 1. 偏差内容

### 1.1 迁移闸门保持开启（p2MigrateEnable=true）

维持 `src/config/mindSwitch.ts` 的 `p2MigrateEnable: true`。`guardP2MentalStateWrite` 范式守卫放行 InnerTick
调用栈向旧 life 业务表（emotions / desires / personality / self_reflections / interaction_memories /
relationship_* 等）写入 LLM 推演产生的情绪、欲望、人格漂移；同时旧 life TICK 定时器被拦截，
不可反向写入业务表（降级为只读快照观测层）。

### 1.2 观测表职责

- `inner_tick_snapshot`：继续作为独立观测快照表，记录每轮 InnerTick 推演完整输出；
- `system_events` 快照备份：Phase1 遗留行为，保留不拆。

### 1.3 开关管控范围（PEPPA_INNER_TICK_ENABLE）

`PEPPA_INNER_TICK_ENABLE` **仅管控 chat_turn 对话回合触发源**（server/socket/innerTickAdapter.ts），
即每轮用户-助手对话结束后由聊天链路发起的 InnerTick 推演；**不管控系统内部调度触发的 InnerTick 调用**，
包括但不限于 scheduler 定时调度、dream（梦境沉淀）、narrative（叙事记忆）、consolidator（记忆整合）、
idle_brain（自主空闲推演）、personality/state、agents/runtime 等其他 runInnerTick 调用点。

### 1.4 实验定位与回退

本偏差用于**渐进式心智迁移实验**：在双轨并行（旧 TICK 只读观测 + InnerTick 写入业务表）模式下观察
LLM 推演心智相对旧规则引擎的演化质量。实验结束后可置 `p2MigrateEnable=false` 回归严格隔离模式
（InnerTick 仅写 inner_tick_snapshot，旧 TICK 恢复原有写库行为），无需代码改动。

## 2. 对应文档同步

偏差签署后，以下文档/注释已同步为一致表述（删除"完全退回改造前行为"等过度承诺描述）：

| 文件 | 修改位置 | 内容 |
| --- | --- | --- |
| server/socket/innerTickAdapter.ts | 头部注释（职责2）、开关说明块、triggerInnerTickAfterChatRound JSDoc、开关检查注释及 DISABLED 日志文本 | 明确 PEPPA_INNER_TICK_ENABLE 仅控制 chat_turn 触发源 |
| .env.example | PEPPA_INNER_TICK_ENABLE 说明段 | 同上，移除过度承诺描述 |
| docker-compose.yml | PEPPA_INNER_TICK_ENABLE 行内注释（配置值未改动） | 同上 |

## 3. 签署确认

- [x] 业务代码逻辑未改动（仅注释/文档/日志描述文本修正）
- [x] `p2MigrateEnable: true` 保持不变
- [x] tsc --noEmit EXIT=0 验证通过
