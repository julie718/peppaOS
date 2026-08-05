# PeppaOS 项目报告

> 生成时间: 2026-08-03  
> 当前 Git commit: `367b24a` (三端一致)

---

## 一、项目概述

PeppaOS（又名 MayOS）是一个数字生命体 AI 助手。通过文字/语音与用户交互，具备情绪、人格、记忆、自我叙事、主动行为等能力。

- **名称**: PeppaOS / MayOS
- **GitHub**: `github.com/julie718/peppaOS`
- **NAS 域名**: `qweasd.top:4043`
- **技术栈**: TypeScript + Node.js(Express) + React + Vite + SQLite + Capacitor + Docker

---

## 二、各端分工与当前状态

### MacBook（开发机）
- **路径**: `/Users/ray/--May-OS`
- **分工**: 写代码、编译检查 (`npx tsc --noEmit`)、git commit/push
- **状态**: ✅ commit `367b24a`，1个未提交调试日志 (`AgentChatPage.tsx` 加了一行 console.log)

### GitHub（代码仓库）
- **地址**: `https://github.com/julie718/peppaOS`
- **分工**: 代码中转站，MacBook push → NAS pull
- **状态**: ✅ `367b24a`

### NAS（服务器）
- **地址**: `qweasd.top:4041` (SSH), `qweasd.top:4043` (HTTPS)
- **源码路径**: `~/mayos/`
- **数据路径**: `~/mayos/data/`（peppa.db, life.db, sherpa-models, skills 等）
- **当前用户**: `ray`
- **状态**: ✅ commit `367b24a`，源码与 MacBook 完全一致（6 个关键文件哈希验证通过）

### NAS Docker 容器
- **镜像名**: `mayos-mayos`
- **镜像构建时间**: 2026-08-03 17:08 CST
- **运行状态**: ✅ Up 2 hours (healthy)
- **入口**: `sh -c "cp -rn /app/skills-bundled/* /app/data/skills/ 2>/dev/null; exec node entry.cjs"`
- **暴露端口**: 3000
- **数据挂载**: `~/mayos/data` → `/app/data`
- **源码挂载**（bind mount，修改后直接生效，无需重建）:
  - `~/mayos/server` → `/app/server`（整个 server 目录）
  - `~/mayos/server.ts` → `/app/server.ts`
  - `~/mayos/db_layer.ts` → `/app/db_layer.ts`
  - `~/mayos/package.json` → `/app/package.json`
  - `~/mayos/routes` → `/app/routes`
- **重要**: 编译产物 `dist-server/server.mjs` 在镜像内，不随 bind mount 更新。`index.ts` 等 TICK 代码已编译进 `server.mjs`，proactive 等模块通过 `npx tsx` 从 bind mount 源码实时编译执行。

### iPhone App
- **类型**: Capacitor 壳 + WKWebView
- **前端来源**: `https://qweasd.top:4043/index.mobile.html`（从 NAS Docker 容器加载）
- **后端连接**: WebSocket `wss://qweasd.top:4043`
- **原生配置**: `ios/App/App/AppDelegate.swift`（已配置 AVAudioSession.playAndRecord）
- **更新方式**: NAS Docker 重建后，杀 App 重开即可（`Cache-Control: max-age=0` 已生效）

### 其他 NAS 容器
| 容器 | 端口 | 用途 |
|------|------|------|
| caddy | 443/4043 | 反向代理 + HTTPS |
| sherpa-asr | 6000 | 本地 STT（中文语音识别） |
| edge-tts | 5050 | TTS 语音合成 |
| hermes | 8000 | LLM 推理 |
| homeassistant | 8123 | 智能家居 |

---

## 三、核心架构

### 消息处理链路
```
用户消息（iPhone WebSocket）
  → chat.ts handleChatMessage()
  → router.ts routeMessage() → 路由分发
    ├─ instinct     → self-aware 应答
    ├─ tool         → 工具调用
    ├─ deep_reasoning → 深度推理（含自身状态判断）
    ├─ cognitive    → 直接 LLM
    └─ orchestrator → 复杂任务拆解
  → LLM 调用 / 工具执行
  → 情绪/人格/方向状态更新
  → 回复 → WebSocket → iPhone
```

### TICK 循环（每 10 分钟，LifeSystem）
```
TICK
  ├─ 步骤0: 生命体征 vitality.tick
  ├─ 步骤1: 情绪衰减 emotions.tickEmotions（含昼夜节律）
  ├─ 步骤1.5: 方向状态演进 direction.tick
  ├─ 步骤2: 欲望生成 desires.generate/tick
  ├─ 步骤3: 人格适应 personality.adapt
  ├─ 步骤4: 关系衰减 relationship.tick
  ├─ 步骤4.5: 人格演化 personality.evolution
  ├─ 步骤5: 自我反思 selfAwareness.reflection
  ├─ 步骤5.6: 主动行为检查 execSync(proactive/index.ts) ✅运行中
  ├─ 步骤5.5: 每日叙事 narrative.daily
  ├─ 步骤6: 闸门检查 heartbeat.gates
  ├─ 步骤7: 数据库维护 backup
  ├─ 步骤7.5: 预判上下文 prefetch
  ├─ 步骤8: 自主探索 autonomousExploration
  └─ 步骤9: 低优先级任务 lowPriorityTasks
```

### 数字生命子系统
| 模块 | 路径 | 说明 |
|------|------|------|
| 情绪 | `server/life/emotions.ts` | 8 维情绪向量 + 昼夜节律 + 基线恢复 |
| 人格 | `server/life/personality.ts` | 8 维人格向量 + 交互微调 |
| 欲望 | `server/life/desires.ts` | 主动欲望生成 |
| 自我意识 | `server/life/selfAwareness.ts` | 反思记录 |
| 关系 | `server/life/relationship.ts` | 关系阶段 + 亲密度 |
| 方向 | `server/life/direction.ts` | 表达倾向(give/neutral/not_give) + 情感/人格联动 + 记忆记录 |
| 叙事 | `server/life/narrative.ts` | 自我叙事生成（含记忆/时间线/知识库融合）|
| 主动行为 | `server/proactive/index.ts` | 触发器检查（晨间问候等），推送链路 (TODO) |

### 记忆系统（M1-M5）
| 模块 | 路径 | 说明 |
|------|------|------|
| 记忆检索 | `server/memory/retriever.ts` | 关键词+语义双路径检索 |
| 时间线 | `server/memory/timeline.ts` | 按时间/事件类型检索 |
| 跨会话 | `server/memory/crossSession.ts` | 用户偏好持久化 |
| 知识库 | `server/memory/knowledgeBase.ts` | 事实规律提炼 |
| 叙事融合 | `server/life/narrative.ts` | M1/M2/M5 融入自我描述 |

### 时间感知
| 模块 | 路径 | 说明 |
|------|------|------|
| 时间上下文 | `server/time/temporal_context.ts` | 日期/季节/节日/周末/关系时长 |
| 时空分析 | `server/time/spatiotemporal.ts` | 时空模式检测 |

### 认知路由层
| 模块 | 路径 | 说明 |
|------|------|------|
| 路由 | `server/cognition/router.ts` | 本能→深度推理→工具→认知→Orchestrator |
| 深度推理 | `server/cognition/deepReasoning.ts` | 四层推理引擎 + 自身状态判断 |
| NLU | `server/cognition/nlu/` | node-nlp 意圖分類(todo) |

---

## 四、关键数据文件

| 文件 | 路径 | 说明 |
|------|------|------|
| peppa.db | `~/mayos/data/peppa.db` | 主数据库（交互记录/用户/设置） |
| life.db | `~/mayos/data/life.db` | 数字生命数据库（情绪/人格/欲望/叙事） |
| sherpa-models | `~/mayos/data/sherpa-models/` | STT 模型文件 |
| skills | `~/mayos/data/skills/` | MCP 技能目录 |

---

## 五、部署流程

```
MacBook 修改代码
  → git add && git commit && git push origin main
  → ssh NAS "cd ~/mayos && git pull && docker compose up -d --build"
  → iPhone 杀 App 重开
```

**注意**: 仅改 server 文件 → bind mount 自动生效（无需 build）。改了 package.json / Dockerfile / 前端源文件 → 必须 `docker compose build`。

---

## 六、连接 NAS 的方式

```
ssh -p 4041 ray@qweasd.top
```

**重要**: NAS 上 `npm` 和 `node` 命令不可用（只有 Docker 容器内有）。操作 NAS 源码用 `docker exec peppaos <命令>` 或在 NAS 上直接编辑 `~/mayos/` 文件。

NAS 源码路径: `~/mayos/`
NAS 数据路径: `~/mayos/data/`

## 七、Docker 构建注意事项

- **构建耗时**: 首次无缓存 10-15 分钟，有缓存几十秒
- **SSH 超时**: 构建超过 5 分钟 SSH 会断，但构建仍在后台进行。用 `docker ps` 检查是否完成
- **僵尸进程**: 每次 SSH 超时后 buildx 进程会残留，需 `killall` 清理后再重试
- **GLIBC 问题**: `node:22-slim` (Bookworm) GLIBC 2.36 与部分预编译二进制不兼容，`npm rebuild` 可解决

## 八、待办事项（优先级排序）

| 优先级 | 任务 | 涉及文件 |
|--------|------|---------|
| P0 | 主动推送链路补全（proactive 触发后 push 到前端） | `server/proactive/index.ts` |
| P0 | `node-nlp` 在 Docker 内通过 `docker compose build` 完成安装并训练模型 | `package.json`, `server/cognition/nlu/` |
| P1 | `git commit && git push` MacBook 上所有未提交修改 | 全部 |
| P1 | Docker 完整重建一次（收拢 scp 和 bind mount 的碎片化部署） | — |
| P2 | Heartbeat 节流从 90 分钟放宽到 30 分钟 | `server/heartbeat/gates.ts` |
| P2 | iPhone 语音通话端到端测试 | `src/hooks/useVoiceCall.ts`, `AppDelegate.swift` |
| P3 | 清理 NAS 上的僵尸 buildx 进程和 `~/mayos/` 根目录下的散落文件 | NAS |
| P3 | NAS 内存不足问题（275MB 空闲） | NAS |

## 九、已知问题

1. **主动推送链路未完成**: `proactive/index.ts` 触发器工作正常（晨间问候已触发），但第 52 行 `// TODO: 推送到前端` 未实现。触发后只打日志，不推送消息。
2. **iPhone 语音通话**: AVAudioSession + AudioContext 已修复，但未充分测试（需要 Xcode 重新编译 App）。
3. **node-nlp NLU 模块**: 代码已创建，桌面端已编译通过，但 NAS 容器内 `npm install` 因 GLIBC 冲突未完成，需 `docker compose build` 安装。
4. **Heartbeat 节流**: 90 分钟间隔过于严格，主动推送几乎全被拦截。
5. **NAS 内存**: 仅 275MB 空闲，6 个容器共享 7.7GB。

## 十、新 Agent 接手第一步

```bash
# 1. 确认能连 NAS
ssh -p 4041 ray@qweasd.top "echo ok"

# 2. 看容器状态
ssh -p 4041 ray@qweasd.top "docker ps"

# 3. 看 MacBook 当前状态
cd ~/--May-OS && git status --short && git log --oneline -5

# 4. 看三端是否同步
git log --oneline -3
git ls-remote origin main
ssh -p 4041 ray@qweasd.top "cd ~/mayos && git log --oneline -3"

# 5. 看 Docker 日志最近输出
ssh -p 4041 ray@qweasd.top "docker logs peppaos --tail 50"

# 6. 开始工作
# 改代码 → npx tsc --noEmit → scp 到 NAS（仅 server/ 文件）或 docker compose build（所有文件）
```

## 十一、本 Agent 踩过的坑（重要！不要重复犯错）

1. ⚠️ **Docker 镜像和 bind mount 是两回事**: `~/mayos/server/` 通过 bind mount 直接映射到容器内 `/app/server/`，改源码立刻生效。但 `dist-server/server.mjs` 是镜像编译出来的静态文件，必须 `docker compose build` 才能更新。之前在这里反复栽跟头——改了 `index.ts` 以为生效了，实际上 TICK 从编译版 server.mjs 运行。
2. ⚠️ **scp 多文件时目标路径要对**: `scp a.ts b.ts host:~/mayos/` 会把文件放到根目录而不是各自的子目录。必须指定完整路径或分开发。
3. ⚠️ **SSH 超时不代表构建失败**: `docker compose build` 超过 5 分钟 SSH 会断，后台构建继续。用 `docker ps` 检查是否完成。但每次超时后 buildx 会残留，要 `ps aux | grep buildx` 检查。
4. ⚠️ **`npx tsc --noEmit` 只检查 TypeScript 语法**: 不代表运行时没问题。GLIBC、依赖缺失等运行时错误只有 Docker 构建后才能发现。
5. ⚠️ **NAS npm 不存在**: NAS 宿主机没有 npm，只有 Docker 容器内有。安装依赖必须通过修改 package.json + Docker 重建，或 `docker exec -u root peppaos npm install`。
6. ⚠️ **MacBook package-lock.json 和 NAS 不同步时 Docker 构建会失败**: 改 package.json 后必须先在 MacBook 上 `npm install --package-lock-only` 更新 lockfile，再 scp 到 NAS。
7. ⚠️ **`console.log` 在 Docker 容器内输出到 stdout**: Docker logs 能捕获。但 Unicode 转义后的中文（如 `主动行为`）grep 搜中文搜不到。

## 十二、完整的项目目录树（核心文件）

```
/Users/ray/--May-OS/
├── docker-compose.yml.sample
├── Dockerfile              ← 多阶段构建(builder+runtime), node:22-slim
├── package.json            ← 含 node-nlp 等依赖
├── capacitor.config.ts     ← iPhone Capacitor 配置
├── PROJECT_REPORT.md       ← 本报告
├── db_layer.ts -> NAS 挂载 →
├── server.ts -> NAS 挂载 →
├── server/
│   ├── socket/             ← WebSocket 处理
│   │   ├── chat.ts         ← ★ 主消息处理 (最深, 2000+行)
│   │   ├── voice.ts        ← 语音通话
│   │   └── perception.ts   ← 感知事件
│   ├── life/               ← ★ 数字生命体系统
│   │   ├── index.ts        ← LifeSystem + TICK 循环
│   │   ├── emotions.ts     ← 情绪引擎(8维+昼夜节律)
│   │   ├── personality.ts  ← 人格引擎(8维)
│   │   ├── direction.ts    ← 方向状态(give/neutral/not_give)
│   │   ├── narrative.ts    ← 自我叙事
│   │   ├── relationship.ts ← 关系管理
│   │   ├── desires.ts      ← 欲望引擎
│   │   └── vitality.ts     ← 生命体征
│   ├── memory/             ← 记忆系统 M1-M5
│   │   ├── retriever.ts    ← M1 记忆检索
│   │   ├── timeline.ts     ← M2 时间线
│   │   ├── crossSession.ts ← M4 跨会话
│   │   ├── knowledgeBase.ts← M5 知识库
│   │   └── store.ts        ← 记忆存储
│   ├── cognition/          ← 认知路由层
│   │   ├── router.ts       ← 消息路由(本能→深度推理→工具→认知)
│   │   ├── deepReasoning.ts← 深度推理 + synthesizeResponse
│   │   └── nlu/            ← NLU 模块(todo)
│   ├── proactive/          ← 主动行为
│   │   ├── index.ts        ← ProactiveManager
│   │   └── triggers.ts     ← 晨间问候等触发器
│   ├── time/               ← 时间感知
│   │   ├── temporal_context.ts ← 时间上下文生成
│   │   └── utils.ts        ← 时间工具
│   ├── heartbeat/          ← 心跳/闸门
│   │   ├── gates.ts        ← 节流控制(MIN_INTERVAL=60min)
│   │   └── injector.ts     ← 推送注入
│   ├── db/                 ← 数据库
│   │   ├── lifeDb.ts       ← life.db 管理(情绪/人格/欲望表)
│   │   └── migrations.ts   ← peppa.db 迁移
│   ├── agents/             ← 子代理系统
│   │   └── orchestrator.ts ← classifyComplexity
│   └── stt/                ← 语音识别
│       └── providers/qwen.ts ← 阿里云 Qwen ASR
├── src/                    ← 前端 React
│   ├── hooks/
│   │   ├── useVoiceCall.ts ← 语音通话核心(iOS修复过)
│   │   ├── useWakeWord.ts  ← 唤醒词
│   │   └── useVoiceprint.ts← 声纹
│   ├── components/
│   │   ├── AgentChatPage.tsx ← 移动端聊天页
│   │   └── VoiceCallButton.tsx
│   └── services/
│       └── sensorPermissionService.ts ← 麦克风权限
└── ios/                    ← iOS 原生
    └── App/App/
        ├── AppDelegate.swift ← AVAudioSession 配置
        └── Info.plist       ← 权限声明
```

## 十三、本次会话上下文（Agent 接手必读）

**会话做了什么（2026-08-01 至 08-03）**:
1. M1-M5 记忆系统全部实现并部署
2. 情绪冻结修复 + emotion_state 追加模式
3. 时间感知三修复 + 深度推理接收 context
4. iOS 语音通话修复 (AVAudioSession + AudioContext)
5. 方向状态模块 (direction.ts) 完整实现
6. 深度推理改为自身状态判断 (去掉外部 LLM)
7. 实体提取 + 方向状态根据事件/动作调整
8. NLU 集成 (未完成: NAS 容器内 node-nlp 未安装)
9. 主动行为模块 (工作正常, 推送链路 TODO)
10. Dockerfile GLIBC 修复 (node:22 替代 slim)
11. 昼夜节律 (emotions.ts + direction.ts)

**当前遗留**:
- MacBook 未提交: AgentChatPage.tsx (调试日志), model.nlp (本地训练)
- Docker 镜像 17:08 构建, 源码哈希已验证一致
- 主动推送链路 `proactive/index.ts:52` 仍是 TODO
- node-nlp 排在 P0 待办
- Heartbeat 节流 60min, 频繁被拦截
