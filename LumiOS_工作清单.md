# LumiOS 工作清单 — 人格核心演进路线

## 核心理念

**"多载体共核心"** — 人格运行时独立于硬件。手机、PC、AR眼镜、全息设备都是 I/O 终端，核心的记忆/偏好/关系网络/行为边界是一套。

**"组装优于自研"** — API、开源项目、MCP 生态、第三方硬件，筛选集成为主。只在人格规范性上做原创。

**"功能演示优先"** — 每个阶段产出可演示的功能，尽快触达市场。

---

## 当前基线

| 层 | 状态 | 说明 |
|---|---|---|
| Layer 1 工具执行 | 13 内置 + MCP client 扩展 + 3 桌面 Tauri IPC | MCP 双向：作为 client 连社区 server，作为 server 暴露 6 工具 |
| Layer 2 LLM 抽象 | 5 家 provider，Qwen 主力 | CosyVoice v3 25 音色 + GPT-SoVITS 本地兜底 |
| Layer 3 记忆演化 | 关键词检索+置信度衰减+LLM提取 | MemoryExplorer 前端面板：搜索/添加/编辑/删除/行为分析 |
| Layer 4 人格定义 | 4 preset + 自定义 | 人格选择器/编辑器/市场，全部前端可用 |
| 语音链路 | STT(Deepgram)→LLM(Qwen)→TTS | CosyVoice 已激活，GPT-SoVITS 9880 端口本地运行 |
| 前端 | 去模拟化完成 | 文件上传/设备发现/传感器/知识导入全部真实 API |
| 安全 | 三级安全分级 | safe/confirm/forbidden + ToolConfirmDialog 确认弹窗 |
| 自主性 | 定时任务框架 | 提醒/记忆衰减/每日摘要/晚间总结/行为分析 |
| 多设备 | 注册/发现/同步 | DeviceSyncCenter 真实 API + Socket.IO 跨设备广播 |
| 全息 | 融合层+输出抽象 | 4 集成点全部接好 sensory context + holographic output |

---

## Phase 1: 语音全链路打通 + 去模拟化

**目标：端到端可用，demo 能展示**

### 1.1 CosyVoice TTS 激活 ✅
- 在阿里云控制台开通"语音合成"服务
- 验证 `server/tts/providers/cosyvoice.ts` 可用
- VoiceForge 显示 CosyVoice 25 个 v3 预设音色
- 文件：`server/tts/providers/cosyvoice.ts`（已更新音色列表）

### 1.2 GPT-SoVITS 本地兜底 ✅
- Python 3.10 + torch + CUDA 环境就绪
- GPT-SoVITS API server 在 9880 端口
- 自定义训练模型 `lumi_voice-e20.ckpt` + `G_600_infer.pth`
- Node 启动时自动 spawn Python 进程，退出时自动 kill
- Tauri `lib.rs` 更新为 `api_v2.py` + YAML config
- 文件：`server/tts/providers/gptsovits.ts`, `server.ts`, `src-tauri/src/lib.rs`

### 1.3 人格选择器 UI
- `Settings.tsx` 或独立组件加人格选择
- 调用 `personalityRegistry.list()` 获取可选人格
- 用户选择后存在 AppContext，语音/聊天都带 `personalityId`
- 文件：`src/components/Settings.tsx` + `src/contexts/AppContext.tsx`

### 1.4 文件上传去模拟化
- `AgentGenerator.tsx` 里知识上传从 mock 改成真实 file input
- 文件存到 `data/uploads/` 或 indexedDB
- 文件：`src/components/AgentGenerator.tsx`

---

## Phase 2: MCP 协议接入 — 工具生态扩展

**目标：工具能力从 13 个扩展到 50+，且大部分是社区维护的**

### 2.1 MCP Client 核心 ✅
- `server/mcp/client.ts` — MCP stdio 客户端
- 支持连接本地 MCP server
- 自动发现 server 提供的 tools，注册到 ToolRegistry
- 文件：`server/mcp/`

### 2.2 首批 MCP Server 集成 ✅
- `@modelcontextprotocol/server-filesystem` — 完整文件系统操作（已启用）
- `@modelcontextprotocol/server-sqlite` — SQLite 读写（已配置，禁用）
- `@modelcontextprotocol/server-git` — Git 操作（已配置，禁用）

### 2.3 MCP 配置管理 ✅
- `server/mcp/config.json` — 声明式配置 ✅
- `src/components/MCPSettings.tsx` — 开关、重启、状态显示 ✅

### 2.4 Lumi as MCP Server ✅（新增）
- Lumi 作为 MCP 服务端暴露 6 个工具给远程设备
- SSE 传输（`/mcp/sse` GET + `/mcp/message` POST）
- 工具：`lumi_chat`, `lumi_memory_search`, `lumi_memory_add`, `lumi_reminder_list`, `lumi_tool_execute`, `lumi_tool_list`
- 远程设备可通过 MCP 协议调用 Lumi 的核心能力
- 文件：`server/mcp/lumi_server.ts`, `server.ts`

---

## Phase 3: 记忆 & 人格面板 — 让核心"可见"

**目标：用户能看到、管理、编辑 AI 对自己的理解**

### 3.1 记忆管理面板 ✅
- Memory Explorer — 按类型分类展示
- 搜索、手动添加、编辑、删除
- 显示置信度和检索次数
- 行为分析按钮
- 文件：`src/components/MemoryExplorer.tsx`

### 3.2 人格编辑器 ✅
- JSON 表单编辑器，创建自定义人格
- 所有字段可编辑：动机、边界、表达风格、工具策略、记忆策略
- 包含安全分级（forbiddenTools、securityOverrides）
- 文件：`src/components/PersonalityEditor.tsx`

### 3.3 人格市场 ✅
- 社区人格的发现/安装
- 后端 marketplace API（curated + GitHub Gist 安装）
- 文件：`src/components/PersonalityMarketplace.tsx` + `server.ts`

---

## Phase 4: 安全层级 & 自主性

**目标：AI 能做更多事，但边界清晰，用户可控**

### 4.1 Claude Code 风格安全分级 ✅
- 三级：`safe`（自动执行）、`confirm`（需确认）、`forbidden`（禁止）
- 5 层安全解析：forbiddenTools → securityOverrides → requireConfirmation → allowedTools → tool default
- ToolConfirmDialog 前端确认弹窗
- 文件：`server/personality/types.ts`, `server/tools/types.ts`, `server/tools/registry.ts`, `src/components/ToolConfirmDialog.tsx`

### 4.2 观察/学习模式 ✅
- `observer` 人格 preset（安静观察，只说有价值的洞察）
- Settings → Neural Engine 观察模式开关
- 记忆提取增强（更低置信度阈值 0.2，检索 20 条）
- 规则化行为分析（每 6h 运行）
- 文件：`server/personality/personalities.json`, `src/components/Settings.tsx`

### 4.3 主动代理行为 ✅
- 定时任务框架（scheduler）
- 提醒检查（5min）、记忆衰减（6h）、每日摘要（9am）、晚间总结（8pm）、行为分析（6h）
- 前端 ProactiveNotifications 弹窗
- 文件：`server/scheduler.ts`, `src/components/ProactiveNotifications.tsx`

---

## Phase 5: 多设备统一

**目标：手机和 PC 共享同一个核心**

### 5.1 设备注册 & 发现
- 设备类型枚举：`desktop | mobile | ar_glasses | holographic_prototype`
- 每个设备有独立的模态能力声明
- 文件：`server/devices/types.ts` + `server/devices/registry.ts`

### 5.2 跨设备记忆同步 ✅
- 记忆添加/更新时广播到所有在线设备
- Socket.IO broadcast 实现
- 文件：`server.ts` + `server/memory/sync.ts` + `src/hooks/useSocket.ts`

### 5.3 设备管理 UI
- `DeviceSyncCenter.tsx` 从模拟改成真实 API
- 显示在线/离线设备、同步状态
- 文件：`src/components/DeviceSyncCenter.tsx`

---

## Phase 6: 全息原型机接入

**目标：第一台原型机接上人格核心**

### 6.1 多模态上下文融合
- 扩展 `PersonalityContext` → 加 `sensoryContext`（活跃感知通道、空间标签）
- 多模态输入预处理层：语音+视觉+空间 → 统一上下文
- 文件：`server/personality/types.ts` + `server/context/fusion.ts`

### 6.2 全息输出抽象 ✅
- 定义 `HolographicOutput` 接口（空间位置、深度、透明度、动画曲线）
- 全息设备的响应格式区别于屏幕设备
- 4 个集成点已全部接入 sensory context + holographic output
- 文件：`server/output/holographic.ts`

---

## 优先级与时间线建议

| Phase | 难度 | 价值 | 状态 |
|-------|------|------|------|
| 1.1 CosyVoice 激活 | 低 | 高 | ✅ 完成 |
| 1.2 GPT-SoVITS 本地 | 中 | 高 | ✅ 完成 |
| 1.3 人格选择器 UI | 低 | 中 | ✅ 完成 |
| 1.4 文件上传去模拟 | 低 | 中 | ✅ 完成 |
| 2.1 MCP Client | 中 | 很高 | ✅ 完成 |
| 2.2 MCP Server 集成 | 低 | 很高 | ✅ 完成 |
| 2.3 MCP 配置管理 | 低 | 中 | ✅ 完成 |
| 3.1 记忆管理面板 | 中 | 高 | ✅ 完成 |
| 3.2 人格编辑器 | 中 | 高 | ✅ 完成 |
| 3.3 人格市场 | 低 | 中 | ✅ 完成 |
| 4.1 安全分级 | 低 | 高 | ✅ 完成 |
| 4.2 观察模式 | 中 | 中 | ✅ 完成 |
| 4.3 主动代理 | 高 | 中 | ✅ 完成 |
| 5.x 多设备 | 中-高 | 高 | ✅ 完成 |
| 6.x 全息接入 | 高 | 战略 | ✅ 完成 |

---

## Verification

每个 phase 完成后的验证方式：
- Phase 1: 语音对话全链路（STT→LLM→TTS），CosyVoice 25 音色可选，本地 GPT-SoVITS 可用
- Phase 2: `npx @modelcontextprotocol/server-filesystem` 连上后，Agent 能操作任意目录
- Phase 3: Memory Explorer 能看到已提取的记忆，Personality Editor 能创建新人格并生效
- Phase 4: 安全操作自动执行，敏感操作弹确认框，禁止操作被拒绝
- Phase 5: 手机和 PC 同时在线，记忆实时同步
- Phase 6: 多模态上下文融合层可组装多设备输入，全息输出接口已连接全部集成点（chat/task/voice/MCP），deviceRegistry 自动感知设备能力并注入 system prompt
