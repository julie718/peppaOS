# PeppaOS (May-OS) 项目结构勘测与能力盘点报告

> 勘测时间: 2026-08-06 | 代码规模: ~11,000+ 行 (仅 server/cognition + life + memory)  
> 数据库交互: 7,144 条 | 用户数: 6 | Agent: 3  
> 部署: Docker Compose + tsx 直接运行源码 + Cloudflare Tunnel

---

## 一、项目结构树 (深度≤3)

```
/Users/ray/--May-OS/
├── server.ts                    ← 入口 (389 lines): Express + Socket.io + LLM 初始化
├── db_layer.ts                  ← 数据层 (980 lines): SQLite peppa.db + 17 张表
├── capacitor.config.ts          ← iPhone WKWebView 配置
├── Dockerfile                   ← 多阶段构建 (builder+runtime)
├── docker-compose.yml           ← NAS Docker Compose (mayos + caddy)
├── package.json
├── vite.config.ts               ← 前端构建 (desktop/web/mobile/org 四模)
│
├── server/
│   ├── socket/                  ← WebSocket 核心
│   │   ├── chat.ts              ← ★ 主消息处理 (2,215 lines)
│   │   ├── voice.ts             ← 语音通话
│   │   ├── perception.ts        ← 感知事件
│   │   └── shared.ts            ← 共享工具
│   │
│   ├── life/                    ← ★ 数字生命体子系统 (8 modules)
│   │   ├── index.ts             ← LifeSystem + TICK 主循环 (683 lines)
│   │   ├── emotions.ts          ← 8维情绪 + 昼夜节律
│   │   ├── personality.ts       ← 人格引擎
│   │   ├── direction.ts         ← 方向状态 (give/neutral/not_give)
│   │   ├── relationship.ts      ← 关系管理
│   │   ├── relationshipAwareness.ts
│   │   ├── desires.ts           ← 欲望引擎
│   │   ├── vitality.ts          ← 生命体征
│   │   ├── narrative.ts         ← 自我叙事 (706 lines)
│   │   ├── selfAwareness.ts     ← 自我反思
│   │   ├── comprehension.ts     ← ★ 理解完整性 (新增, 112 lines)
│   │   └── userState.ts         ← 用户活跃状态
│   │
│   ├── cognition/               ← 认知路由层
│   │   ├── router.ts            ← 5层消息路由 (167 lines)
│   │   ├── deepReasoning.ts     ← 深度推理 + synthesizeResponse (720 lines)
│   │   ├── intent.ts            ← 意图分类
│   │   ├── quick_commands.ts    ← 快速命令匹配
│   │   ├── tool_router.ts       ← 工具路由
│   │   ├── fallback.ts          ← 降级处理
│   │   └── nlu/                 ← NLU 意图识别 (node-nlp)
│   │
│   ├── memory/                  ← ★ 记忆系统 (18 files)
│   │   ├── store.ts             ← 记忆存储 (1,112 lines)
│   │   ├── retriever.ts         ← 关键词+语义检索
│   │   ├── timeline.ts          ← 时间线检索
│   │   ├── crossSession.ts      ← 跨会话记忆
│   │   ├── knowledgeBase.ts     ← 知识提取
│   │   ├── consolidator.ts      ← 记忆固化
│   │   ├── dream.ts             ← 梦境循环
│   │   ├── prefetch.ts          ← 预取上下文
│   │   ├── focusStack.ts        ← 焦点栈
│   │   └── ...                  ← behavioral, extractor, firewall, sync, tree
│   │
│   ├── tools/                   ← MCP 工具系统
│   │   ├── registry.ts          ← ToolRegistry (注册/执行/安全)
│   │   ├── types.ts             ← ToolDefinition, ToolContext, SecurityLevel
│   │   ├── action_constitution.ts ← 动作宪法
│   │   ├── responseFormatter.ts
│   │   └── definitions/         ← ★ 41 个工具定义文件
│   │
│   ├── runtime/                 ← 运行环境初始化
│   │   ├── core.ts              ← Express app 创建
│   │   ├── socket.ts            ← Socket.io 初始化 (91 lines)
│   │   ├── bootstrap.ts         ← 启动流程
│   │   ├── llm.ts               ← LLM 运行时
│   │   ├── routes.ts            ← 路由挂载
│   │   ├── mcp_server.ts        ← MCP 服务端
│   │   └── messaging.ts         ← 消息集成
│   │
│   ├── scheduler.ts             ← ★ 定时调度器 (cron + setInterval)
│   ├── proactive/               ← 主动行为
│   │   ├── index.ts             ← ProactiveManager
│   │   └── triggers.ts          ← 晨间问候等触发器
│   ├── heartbeat/               ← 心跳/闸门
│   │   ├── gates.ts             ← 节流控制 (60min间隔)
│   │   └── injector.ts          ← 推送注入
│   │
│   ├── agents/                  ← 子代理系统
│   │   ├── orchestrator.ts      ← 任务拆解
│   │   ├── background_tasks.ts  ← 后台任务
│   │   ├── nl_chainer.ts        ← NL 链式调用
│   │   └── ...
│   │
│   ├── conversation/            ← 会话管理
│   ├── personality/             ← 人格注册
│   ├── llm/                     ← LLM 提供者适配
│   ├── stt/ tts/                ← 语音识别/合成
│   ├── mcp/                     ← MCP 通信层
│   ├── db/                      ← life.db 管理
│   ├── middleware/               ← 仅 auth.ts
│   ├── context/                 ← 上下文管理 (含 activity_stream)
│   ├── autonomy/                ← 自主性管理
│   ├── lib/                     ← 工具库 (logger, pushService...)
│   └── ...                      ← 30+ 其他子系统目录
│
├── src/                         ← React 前端
│   ├── components/              ← 86 个组件
│   ├── hooks/                   ← 18 个 hooks (语音/声纹/唤醒词)
│   ├── entries/                 ← 多入口 (desktop/web/mobile/org)
│   └── services/                ← 15 个服务
│
└── ios/                         ← iOS Capacitor 壳
    └── App/App/
        ├── AppDelegate.swift    ← AVAudioSession + 本地通知
        └── Info.plist
```

---

## 二、核心文件路径对照表

| 功能 | 文件 | 关键函数/位置 |
|------|------|-------------|
| **启动入口** | server.ts:1-389 | Express + Socket.io init → bootstrap |
| **消息处理** | server/socket/chat.ts:276 | `socket.on("agent:chat")` → route → handle |
| **消息路由** | server/cognition/router.ts:69 | `routeMessage()` → 5层分发 |
| **深度推理** | server/cognition/deepReasoning.ts | `getSelfState()`, `synthesizeResponse()` |
| **NLU 意图** | server/cognition/nlu/index.ts | `parseIntent()` |
| **TICK 循环** | server/life/index.ts:344 | `LifeSystem.tick()` → 10个步骤 |
| **情绪引擎** | server/life/emotions.ts | 8维向量 + 昼夜节律 |
| **理解完整性** | server/life/comprehension.ts | `updateComprehension()`, `generateClarification()` |
| **MCP 工具注册** | server/tools/registry.ts:38 | `ToolRegistry.register()` |
| **工具类型** | server/tools/types.ts | `ToolDefinition`, `SecurityLevel` |
| **工具定义** | server/tools/definitions/ | 41个文件, 每个含 handler+parameters |
| **定时调度** | server/scheduler.ts | `Scheduler` 类 (cron + interval) |
| **主动行为** | server/proactive/index.ts | `ProactiveManager.run()` |
| **心跳闸门** | server/heartbeat/gates.ts | 节流+日限额+静默时段 |
| **数据库** | db_layer.ts:231 | `createTables()` → 17张SQLite表 |
| **life.db** | server/db/lifeDb.ts | 情绪/欲望/叙事表 |
| **会话管理** | server/conversation/manager.ts | `getOrCreateActiveConversation()` |
| **Socket 连接** | server/runtime/socket.ts:91 | `io.on("connection")` → 注册 handlers |
| **JWT 鉴权** | server.ts:16 | `process.env.JWT_SECRET` |
| **CORS** | docker-compose.yml | `CORS_ORIGINS` 环境变量 |
| **身份认证** | server/middleware/auth.ts | 唯一中间件 |

---

## 三、能力盘点表格

### 3.1 现有原生具备能力

| 能力 | 状态 | 实现位置 | 备注 |
|------|------|---------|------|
| 多模型 LLM 接入 | ✅ | server/llm/providers.ts | 11 种提供者 (DeepSeek/OpenAI/Anthropic/Gemini/Qwen/Ark/Xiaomi/Kimi/GLM/Ollama/LMStudio) |
| NLU 意图识别 | ✅ | server/cognition/nlu/ | node-nlp, 中文, 4种意图分类 |
| 5层消息路由 | ✅ | server/cognition/router.ts | instinct→deep_reasoning→NLU→tool→cognitive/orchestrator |
| 深度推理(自身状态) | ✅ | server/cognition/deepReasoning.ts | getSelfState + synthesizeResponse |
| 情绪系统 | ✅ | server/life/emotions.ts | 8维向量 + 昼夜节律 + 基线恢复 |
| 人格系统 | ✅ | server/life/personality.ts | 8维向量 + 交互微调 |
| 方向状态 | ✅ | server/life/direction.ts | give/neutral/not_give + 联动 |
| 关系管理 | ✅ | server/life/relationship.ts | 关系阶段 + 亲密度 |
| 欲望引擎 | ✅ | server/life/desires.ts | 主动生成 |
| 自我叙事 | ✅ | server/life/narrative.ts | 每日 + 事件驱动 |
| 理解完整性 | ✅ | server/life/comprehension.ts | 3维状态 + 追问生成 (新增) |
| 记忆检索 | ✅ | server/memory/retriever.ts | 关键词+语义双路径 |
| 时间线 | ✅ | server/memory/timeline.ts | 按事件类型/时间范围 |
| 跨会话记忆 | ✅ | server/memory/crossSession.ts | key-value 持久化 |
| 知识库 | ✅ | server/memory/knowledgeBase.ts | 18种规则提取 |
| 记忆固化 | ✅ | server/memory/consolidator.ts | episodic + narrative |
| MCP 工具系统 | ✅ | server/tools/registry.ts | 41 个工具, 安全分级 |
| 定时调度 | ✅ | server/scheduler.ts | cron + interval, ~20 个注册任务 |
| 主动行为 | ✅ | server/proactive/ | 触发器+push (push链路已补) |
| 心跳闸门 | ✅ | server/heartbeat/gates.ts | 60min间隔 + 日限额10次 + 静默时段 |
| 会话管理 | ✅ | server/conversation/manager.ts | 创建/分支/摘要/自动 |
| 语音通话 | ✅ | server/socket/voice.ts | WebSocket + STT + TTS |
| JWT 鉴权 | ✅ | server.ts + middleware/auth.ts | 24h过期 |
| TICK 循环 | ✅ | server/life/index.ts | 10分钟间隔, 10步 |
| 上下文预取 | ✅ | server/memory/prefetch.ts | ACI预判 |
| 空闲检测 | ✅ | server/context/activity_stream.ts | idle state machine + scheduler idle_check |
| iPhone WKWebView | ✅ | capacitor.config.ts | 远程加载 mobile.html |
| Tauri 桌面 App | ⚠️ | src-tauri/ | 框架就绪, 二进制未编译 |
| 多消息渠道集成 | ⚠️ | server/messaging/ | 飞书/微信/企业微信 (部分完成) |

### 3.2 原生缺失能力

| 缺失能力 | 严重度 | 影响范围 | 说明 |
|----------|--------|---------|------|
| **长期记忆持久化** | 🔴 高 | 记忆系统 | 记忆存储在 peppa.db 的 memories 表, 但缺少结构化长期记忆提取和应用机制 |
| **对话复盘/反思** | 🔴 高 | 自我意识 | selfAwareness.reflection 仅做简单统计, 无深度对话回顾分析 |
| **MCP 调用限流** | 🟡 中 | 工具安全 | 工具注册有 SecurityLevel 但缺少 per-session 调用次数上限 |
| **后台待机深度思考** | 🟡 中 | 自主性 | scheduler 有 idle_check 但仅发事件, 无独立推理进程 |
| **人格固化 Prompt** | 🟡 中 | 人格系统 | 人格向量存在于 db 但未编译进 system prompt; personality registry 可扩展 |
| **情绪变量 Token 注入** | 🟡 中 | 情绪系统 | 情绪状态在 TICK 中更新但未注入到 LLM conversation context |
| **对话前/后置钩子** | 🟡 中 | 扩展性 | chat.ts 内无 onChatStart/onChatEnd 可挂载钩子 |
| **MCP 工具链式调用阻断** | 🟢 低 | 工具安全 | workflow_tools 支持链式, 但无循环检测/最大深度限制 |
| **Redis/外部缓存** | 🟢 低 | 性能 | 仅有 SQLite 文件存储, 无 Redis 或内存缓存 |
| **向量数据库** | 🟢 低 | 语义检索 | 无向量存储 (FAISS/chroma/pgvector), 语义仅靠关键词 |
| **多轮对话去重** | 🟢 低 | 体验 | 无消息去重机制 |
| **模型 Fallback 链** | 🟢 低 | 可用性 | 单一 LLM provider, 无自动切换 |

---

## 四、MCP 工具现状专项调研

### 4.1 工具触发机制

**当前: 混合模式**

1. **规则路由 → 工具层**: `router.ts` 中 `hasToolIntent()` 通过关键词正则匹配判定 (第144行), 返回 `layer: 'tool'`
2. **NLU 路由**: `nluResult.intent === 'ask_fact'` → `layer: 'tool'`
3. **模型自主调用**: `runWithTools()` (server/llm/adapter.ts) 允许 LLM 自主选择工具, 使用 function calling

**结论**: 既有被动规则触发, 也有模型自主判断调用。非纯 LLM 自主模式。

### 4.2 工具安全控制

| 控制项 | 状态 | 详情 |
|--------|------|------|
| SecurityLevel 分级 | ✅ | safe / confirm / forbidden (types.ts:5) |
| ToolPolicy 白/黑名单 | ✅ | personality/types.ts: `allowedTools` + `forbiddenTools` |
| 动作宪法 | ✅ | action_constitution.ts: `evaluateActionConstitution()` |
| per-session 调用上限 | ❌ | 无 |
| 链式调用深度限制 | ❌ | workflow_tools 可链式调用, 无最大深度 |
| 工具调用超时 | ✅ | 部分工具 (web_tools/news_tools 等) 有 AbortController 超时 |
| 参数校验 | ✅ | `normalizeJsonSchema()` 将 flat 格式转 JSON Schema |
| 工具权限分级 | ✅ | public / user / admin / system (ToolPermission) |
| 用户确认回调 | ✅ | `ToolContext.requestConfirmation` |
| 取消检查 | ✅ | `ToolContext.isCancelled` |
| 后台自主工作标记 | ✅ | `ToolContext.autonomous` |

### 4.3 工具返回处理

| 项目 | 状态 |
|------|------|
| 时效标记 | ❌ 无 |
| 临时数据隔离 | ❌ 无 (ToolContext 有 `domain` 和 `orgId` 字段但未强制隔离) |
| 结果格式化 | ✅ responseFormatter.ts |
| 进度回调 | ✅ `ToolContext.onProgress` |
| 工具开始回调 | ✅ `ToolContext.onToolStart` |

### 4.4 工具清单 (41 个文件, 约 300+ 个工具)

```
授权研究: authority_research_tools.ts
自主性: autonomy_tools.ts
生物识别: biometric_tools.ts
日历: calendar_tools.ts
能力研究: capability_research_tools.ts
客户端: client_self_tools.ts
剪贴板: clipboard_tools.ts
代码: code_tools.ts
计算机使用: computer_use_tool.ts
数据: data_tools.ts
桌面: desktop_tools.ts
文档: document_tools.ts
外部应用: external_app_tools.ts
文件操作: file_ops.ts
Git: git_tools.ts
图片: image_tools.ts
输入: input_tools.ts
法律: legal_tools.ts
新闻: news_tools.ts
OCR: ocr_tools.ts
办公: office_tools.ts
PDF: pdf_tools.ts
Python: python_tools.ts
提醒: reminder_tools.ts
屏幕监控: screen_monitor.ts
自我扩展: self_extension_tools.ts
技能: skill_tools.ts
睡眠/梦境: sleep_tools.ts
系统操作: system_ops.ts
升级: upgrade_tools.ts
用量: usage_tools.ts
验证: verify_tools.ts
视频: video_tools.ts
天气: weather_tools.ts
Web登录: web_login_tools.ts
Web: web_tools.ts
工作产物: work_product_tools.ts
工作流: workflow_tools.ts
适配器: adapter_tools.ts
代理: agent_tools.ts
```

---

## 五、对话全生命周期分析

### 5.1 无正式钩子系统

**关键发现: chat.ts 内没有 `onChatStart` / `onChatEnd` / `beforeMessage` / `afterMessage` 等可挂载钩子。**

消息处理流程是硬编码的线性执行:

```
socket.on("agent:chat")  [chat.ts:276]
  → JWT 鉴权
  → 会话创建/获取
  → 上下文构建 (记忆/时间线/知识库/system prompt)
  → routeMessage() 路由判定
  → 按路由层执行:
      instinct → 直接应答
      deep_reasoning → NLU → comprehension → selfState → synthesizeResponse
      tool → runWithTools
      cognitive → makeLLMCall
      orchestrator → runOrchestratedTask
  → emit("agent:response")
  → cleanup (chatSessionMap.delete)
```

### 5.2 可挂载点位

| 位置 | 文件:行号 | 当前状态 | 可挂载性 |
|------|----------|---------|---------|
| Socket 连接 | socket.ts:91 | `io.on("connection")` | 可在 chat.ts handler 注册前插入 |
| 聊天消息接收 | chat.ts:276 | `socket.on("agent:chat")` 回调首行 | **最理想的前置钩子位置** |
| 路由判定后 | chat.ts:946-947 | `if (route.layer === 'deep_reasoning')` | 按层插入 |
| 回复发送前 | chat.ts:1089 | `socket.emit('agent:response', ...)` | 后置钩子 |
| 会话结束 | chat.ts:980 | `chatSessionMap.delete(sessionKey)` | session destroy |
| Socket 断开 | socket.ts:130 | `socket.on("disconnect")` | 全局 disconnect |
| 对话关闭 | conversation/manager.ts | `getOrCreateActiveConversation()` | 无 end 事件 |

---

## 六、存储实现分析

### 6.1 peppa.db (主数据库, db_layer.ts:231)

17 张 SQLite 表:

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| users | 用户账号 | uid, username, password, role, balance |
| agents | AI Agent定义 | id, name, category, config, personalityId, autonomyLevel |
| interactions | 交互记录 ★ | userId, agentId, message, response, conversationId, toolCalls |
| conversations | 会话 | id, userId, agentId, title, mode, summary |
| memories | 记忆存储 | key, value, type, perspective, timestamp |
| skills | 安装的技能 | id, name, version, config |
| settings | 系统设置 | key, value |
| org_* | 组织管理 (6张) | organizations, departments, memberships, invitations, kb_articles, kb_embeddings |
| token_usage | Token 用量 | userId, provider, model, tokens |
| reminders | 提醒 | userId, text, dueAt |
| event_log | 事件日志 | type, data |
| notifications | 通知 | userId, type, content |
| marketplace_skills | 技能市场 | name, version, author |
| voice_profiles | 语音配置 | userId, voiceId |
| audit_log | 审计日志 | action, userId, timestamp |
| agent_templates | Agent 模板 | name, config |
| canvas_sessions | 画布会话 | userId, data |
| founder_vision | 创始人愿景 | content |

### 6.2 life.db (数字生命体数据库)

server/db/lifeDb.ts 管理, 包含:
- emotion_state (追加模式)
- personality_state
- desire_state
- narrative_state
- relationship_state
- reflection_state
- system_events

### 6.3 缓存与向量存储

| 类型 | 状态 |
|------|------|
| Redis | ❌ 无 |
| 文件缓存 | ⚠️ heartbeat_state.json, scheduler disabled_tasks |
| 内存缓存 | ⚠️ Map 结构 (chatSessionMap, idleState, 等) |
| 向量存储 | ❌ 无 (仅有 org_kb_embeddings SQLite 表存储 embedding JSON) |
| 文件存储 | ✅ `/app/data/` 目录 (skills, models, sherpa-models) |

---

## 七、定时调度与后台任务

### 7.1 Scheduler (server/scheduler.ts)

**调度器类型**: 自实现 Scheduler 类, 支持 cron 表达式 + 固定间隔

**已注册任务** (从日志中识别):

| 任务 ID | 间隔 | 说明 |
|---------|------|------|
| proactive_peppa_scan | 3600s | 主动行为扫描 |
| memory_this_day | 86400s | 记忆日回顾 |
| spatiotemporal_analysis | 21600s | 时空模式分析 |
| ephemeral_cleanup | 3600s | 临时数据清理 |
| ambient_activity_poll | 3600s | 环境活动轮询 |
| idle_check | 3600s | 空闲检查 |
| autonomous_work_cycle | 3600s | 自主工作循环 |
| daily_system_scan | 3600s | 每日系统扫描 |

### 7.2 TICK 循环 (server/life/index.ts)

**机制**: setInterval @ 10 分钟

**10 个步骤**:
```
步骤0: 生命体征 vitality.tick
步骤1: 情绪衰减 emotions.tickEmotions
步骤1.5: 方向演进 direction.tick
步骤1.6: 理解完整性衰减 comprehension.tick
步骤2: 欲望生成/衰减 desires.tick
步骤3: 人格适应 personality.adaptToEvent
步骤4: 关系衰减 relationship.tick
步骤4.5: 人格演化 personality.evolution
步骤5: 自我反思 selfAwareness.reflection (夜间触发)
步骤5.5: 每日叙事 narrative.daily (24h一次)
步骤5.6: 主动行为 proactiveManager.run()
步骤6: 闸门检查 heartbeat.gates
步骤7: 数据库维护 autoBackup
步骤7.5: 预判上下文 prefetchContext
步骤8: 自主探索 autonomousExploration
步骤9: 低优先级任务 lowPriorityTasks
```

---

## 八、空闲状态判断能力

### 8.1 现有检测机制

1. **activity_stream.ts** (server/context/activity_stream.ts)
   - `trackUserActivity()` — 记录用户活动
   - `getIdleState()` — 查询空闲状态 `{ isIdle: boolean, idleSince?: string }`
   - 空闲事件: `user_idle_start` / `user_idle_end`
   - 状态机: `idleState` Map<userId, {isIdle, idleSince}>

2. **scheduler.ts `idle_check`** (第1668行)
   - 每小时 broadcast `ambient:idle_check` 到前端
   - 前端返回 `ambient:idle_report` 告知空闲时长
   - 可检测全局会话空闲 (长时间无消息)

3. **heartbeat/gates.ts**
   - `isSilentHour()` — 23:00-07:00 静默时段检查
   - `isThrottled()` — 60分钟间隔节流

### 8.2 当前局限

- 空闲检测依赖前端心跳回报, 无服务端主动判断
- 闲置时无独立的深度思考/推理进程
- `userState.ts` (43 lines) 仅有 activity touch, 功能简单

---

## 九、环境变量全面梳理

| 变量 | 用途 | 存储位置 |
|------|------|---------|
| DEEPSEEK_API_KEY | DeepSeek LLM | .env |
| OPENAI_API_KEY | OpenAI LLM | .env |
| ANTHROPIC_API_KEY | Claude LLM | .env |
| GEMINI_API_KEY | Gemini LLM | .env |
| DASHSCOPE_API_KEY | Qwen/阿里云 | .env |
| DEEPGRAM_API_KEY | STT 语音识别 | .env |
| DOUBAO_SPEECH_KEY | Doubao TTS | .env |
| JWT_SECRET | JWT 签名密钥 | .env + docker-compose.yml |
| OXOG_ENV_KEY | API Key 加密密钥 | .env.example |
| PEPPA_PASSWORD | 自动登录密码 | docker-compose.yml |
| PORT | 服务端口 (3000) | .env |
| CORS_ORIGINS | CORS 白名单 | docker-compose.yml |
| NODE_ENV | 运行环境 | docker-compose.yml |
| HOST | 绑定地址 | docker-compose.yml |
| LUMI_ROLE | personal/org | .env |
| NLU_MODEL_PATH | NLU模型路径 | .env |
| LUMI_DATA_DIR | 数据目录 | docker-compose.yml |
| CONTEXT_TOKEN_BUDGET | Token预算 | docker-compose.yml |
| LUMI_ALLOWED_COMMANDS | MCP shell命令白名单 | .env |
| NETEASE_APP_ID/PRIVATE_KEY | 网易云音乐 | server.ts |
| ARK/KIMI/GLM/ZHIPU/MOONSHOT/XIAOMI/RELAY | 备用 LLM 密钥 | .env |
| SUPABASE_* | 云同步 | .env |

---

## 十、可用于数字生命体改造的扩展接口/钩子清单

### 10.1 可直接使用的插入点

| 编号 | 位置 | 文件:行号 | 用途 | 风险 |
|------|------|----------|------|------|
| E1 | 消息接收入口 | chat.ts:276 | `agent:chat` 回调首行 → 添加前置 hook | 🟢 低 |
| E2 | 路由判定后 | chat.ts:947 | 各路由层分支 → 添加层级 hook | 🟢 低 |
| E3 | 回复发送前 | chat.ts:~1089 | `agent:response` emit 前 → 后置 hook | 🟢 低 |
| E4 | TICK 循环 | life/index.ts:344 | tick() 方法内 → 插入新步骤 | 🟢 低 |
| E5 | Scheduler 注册 | scheduler.ts | `register()` → 添加新定时任务 | 🟢 低 |
| E6 | Socket 连接/断开 | socket.ts:91/130 | connection/disconnect → 生命周期事件 | 🟢 低 |
| E7 | Proactive 触发器 | proactive/index.ts | `allTriggers[]` → 注册新触发器 | 🟢 低 |
| E8 | ToolContext | tools/types.ts | onToolStart, onProgress → 工具回调 | 🟢 低 |
| E9 | EmotionEngine | life/emotions.ts | `receivePerception()` → 外部情绪注入 | 🟢 低 |
| E10 | System prompt 构建 | chat.ts:~593 | systemPrompt 字符串拼接 → 注入动态上下文 | 🟡 中 |

### 10.2 需新建的扩展接口

| 编号 | 接口 | 建议文件 | 用途 |
|------|------|---------|------|
| N1 | `ChatHooks` | 新建 server/hooks/chat.ts | onBeforeMessage, onAfterMessage, onBeforeResponse, onAfterResponse |
| N2 | `ConversationHooks` | 新建 server/hooks/conversation.ts | onConversationStart, onConversationEnd |
| N3 | `PluginSystem` | 新建 server/plugins/registry.ts | 插件注册/卸载/生命周期 |
| N4 | `IdleBrain` | 新建 server/autonomy/idle_brain.ts | 空闲时的独立推理进程 |

---

## 十一、改造风险点 (修改导致异常)

| 风险等级 | 位置 | 修改内容 | 后果 |
|----------|------|---------|------|
| 🔴 极高 | server.ts Express 初始化 | 改 Express 实例创建或 listen | 容器启动失败 |
| 🔴 极高 | socket.ts `io.on("connection")` | 改连接处理逻辑 | 所有 WebSocket 通信中断 |
| 🔴 极高 | chat.ts:276 `agent:chat` handler | 改消息接收签名 | 用户消息完全进不来 |
| 🔴 极高 | db_layer.ts `createTables()` | 改表结构无迁移 | SQLite 报错, 启动失败 |
| 🔴 极高 | docker-compose.yml `command:` | 改启动命令 | 容器无法启动 |
| 🟡 高 | router.ts `routeMessage()` | 改路由层顺序 | 消息分发错误 |
| 🟡 高 | session/cookie 配置 | 改鉴权逻辑 | 所有请求 401 |
| 🟡 高 | CORS_ORIGINS | 删或忘加域名 | iPhone App 白屏/消息不通 |
| 🟢 中 | life/index.ts TICK | 步骤顺序错误 | 情绪/人格状态演进异常 |
| 🟢 中 | toolRegistry.register() | 注册冲突 | 工具不可用 |
| 🟢 低 | 新增 hook/插件文件 | 不影响现有流程 | 不会导致崩溃 (渐进式) |

---

## 十二、不修改的核心代码清单

以下代码 **绝对不修改**:

1. **容器启动**: docker-compose.yml `command: npx tsx /app/server.ts`, Dockerfile ENTRYPOINT
2. **MCP 底层通信**: server/mcp/ws_transport.ts, server/runtime/mcp_server.ts
3. **会话管理核心**: server/conversation/manager.ts (CRUD), chat.ts 的 conversationId 管理
4. **前端接口**: `agent:chat`, `agent:response`, `agent:status` Socket 事件协议
5. **鉴权**: JWT_SECRET 注入, auth middleware
6. **数据库初始化**: db_layer.ts `createTables()`, lifeDb.ts `migrateLifeTables()`

---

## 十三、Agent 深度扫描补充发现 (2026-08-06)

以下由 4 个并行 Agent 深度扫描确认，修正/补充上方报告:

### 修正：Scheduler 任务数量
实际有 **~26-30 个定时任务**，不是 8 个。包括: reminder_check, memory_decay, memory_crystallization, memory_consolidation, narrative_consolidation, sleep_dream_cycle, daily_summary, evening_wrapup, behavioral_analysis, memory_auto_organize, personality_evolution, weekly_review, monthly_review, yearly_review, auto_skill_gen, auto_workflow_gen, health_audit, growth_journal, agent_autonomous_tick, proactive_peppa_scan, memory_this_day, spatiotemporal_analysis, ephemeral_cleanup, ambient_activity_poll (10s), idle_check (1min), autonomous_work_cycle (10min), daily_system_scan。

### 修正：工具数量
- 原生工具注册函数: 40 个 `register*Tools()` (不是 39 个)
- MCP 暴露工具: 10 个 (`peppa_chat`, `peppa_memory_search`, `peppa_memory_add`, `peppa_reminder_list`, `peppa_speak`, `peppa_narrative`, `peppa_agent_share`, `peppa_list_workers`, `peppa_worker_status`, `peppa_route_task`)
- 总计: **~300+ 工具**

### 修正：MCP 工具安全控制层（8层，不是3层）
1. `forbiddenTools` 黑名单
2. `securityOverrides` 安全级别覆盖
3. `requireConfirmation` 强制确认
4. `allowedTools` 白名单
5. `evaluateActionConstitution()` — 按 domain (observe/draft/local_write/desktop_control/external_app/messaging/system/network/destructive) 分类检查
6. 用户确认回调 (`context.requestConfirmation`)
7. 重复检测 (LLM adapter 防无限循环)
8. `maxIterations` 硬限制 (per-mode: autonomous=50, assistant=25, chat=0)

### 修正：数据库表数
peppa.db: **22 张表** (不是 17 张), 包括新增: `contacts`, `schema_version`
life.db: **12 张表** + 1 迁移表

### 新增发现：内存缓存策略
- `memoryDB` 全量内存缓存 (db_layer.ts) — 所有读操作不执行 SQL
- Embedding LRU 缓存 (`Map<string, number[]>`, 500 entries) — OpenAI text-embedding-3-small
- Hebbian 共现记忆关联 (`Map<string, Map<string, number>>`)
- 5分钟行为调整缓存 (`relationshipAwareness.ts`)
- 30分钟路由缓存 (`orchestrator.ts`)

### 新增发现：空闲检测是7层系统
1. `userState.ts` — `__lastUserMessageAt` 全局时间戳
2. `activity_stream.ts` — per-user `{isIdle, idleSince}` 状态机
3. `ambient.ts` — `ambient:idle_report` 前端回报 (阈值 60s)
4. `safety_gate.ts` — `userLastIdle` Map + 空闲门控后台任务
5. `scheduler.ts` — `idle_check` (每1分钟) + `ambient_activity_poll` (10s)
6. `mainLoop.ts` — 3分钟无活动判定
7. `heartbeat/gates.ts` — `isUserActive()` (5分钟阈值)

### 新增发现：人格固化已存在
`/server/personality/personalities.json` + `personality/registry.ts` 管理 Agent 人格定义，包含 toolPolicy (allowedTools, forbiddenTools, maxIterations, requireConfirmation)。每天凌晨 3-4 点 `selfAwareness.reflection` 触发 LLM 反思（危险关键词过滤 + 硬回退模板）。人格矢量存储在 `personality` 和 `personality_evolution` 表中。

### 新增发现：事件系统
**无 EventEmitter、EventBus、PubSub**。所有事件通信使用 Socket.io (`io.emit`)。关键 emit 事件: `agent:proactive`, `ambient:idle_check`, `ambient:poll_request`, `personality:evolved`, `memories:changed`, `org:sync:ack`, `proactive:trigger`。

---

## 十四、总结

| 维度 | 评分 | 说明 |
|------|------|------|
| 代码规模 | ★★★★☆ | ~15,000+ 行后端代码, 30+ 子系统目录 |
| 认知能力 | ★★★★☆ | 5 层路由 + 深度推理 + NLU + 情绪/人格 |
| 记忆系统 | ★★★☆☆ | 5 模块完备但缺长期记忆融合 |
| MCP 工具 | ★★★★☆ | 41 工具 + 安全分级, 缺限流 |
| 自主性 | ★★★☆☆ | TICK + Scheduler 框架就绪, 缺深度待机推理 |
| 扩展性 | ★★☆☆☆ | **最大短板**: 无钩子系统, 无插件架构, 策略硬编码 |
| 可靠性 | ★★★☆☆ | SQLite + 文件状态持久化, 无外部缓存 |

**后续改造最优先**:
1. 建立 ChatHooks 系统 (E1/E2/E3)
2. 情绪变量注入 system prompt (E10)
3. MCP per-session 限流
4. 空闲时深度推理 (IdleBrain)
5. 对话复盘/反思机制
