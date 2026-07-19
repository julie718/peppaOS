# PeppaOS 项目状态评估报告

## 评估日期
2026-07-19

## 1. 摘要

**整体状态：亚健康**

NAS 运行基本稳定（在线 25 小时），核心功能可用。但存在大量 Agent 自动生成的垃圾技能（58 个未连接）、硬编码 JWT 密钥散落 7 个文件、82 个技能中仅 24 个连接。近期完成的 5 项优化（加密存储、日志标准化、健康检查、主循环、按需工具注入）已推送到 GitHub，但**NAS 容器未重建部署**——这些优化在线上均未生效。

## 2. 各维度评估详情

### 2.1 代码质量与工程健康度

| 指标 | 数值 | 评估 |
|------|------|------|
| TypeScript 编译 | ✅ 零错误 | 良好 |
| TODO/FIXME 注释 | 5 处 | 可接受 |
| 硬编码 JWT 密钥 | 7 个文件 | ⚠️ 安全风险 |
| 未使用依赖 | 未测（depcheck 未安装） | 待确认 |
| try-catch 覆盖率 | 80+ 空 catch {} | ⚠️ 错误被静默吞噬（审计报告已发现） |
| 长函数 | scheduler.ts(1760行)、chat.ts(1700+行) | ⚠️ 需拆分 |

### 2.2 功能完成度矩阵

| 功能 | 状态 | 说明 |
|------|------|------|
| 对话系统（Chat） | ✅ 可运行 | 文字/语音双通道，5 个 LLM 提供商 |
| 记忆引擎（Memory） | ✅ 可运行 | 叙事链刚刚优化 |
| 人格引擎（Personality） | ✅ 可运行 | 进化/情绪/宪法完整 |
| 自主任务调度（Autonomy） | ✅ 可运行 | MainLoop + Scheduler 双调度 |
| 知识库与 RAG | ✅ 可运行 | 法律知识库可用 |
| MCP 工具系统 | 79 MCP + 143 内置 | ⚠️ 大量无效残留 |
| 语音交互（TTS/STT） | ✅ 可运行 | Deepgram(听) + 豆包(说) |
| 画布工作台（Canvas） | ✅ 可运行 | |
| 3D 全息层 | ⚠️ 部分实现 | 代码存在，桌面端渲染 |
| iOS 适配 | ✅ 可运行 | Capacitor App |
| 组织协作 | ⚠️ 部分实现 | 代码存在，未深度使用 |
| 生物识别 | ⚠️ 部分实现 | 软通行（soft-pass） |

### 2.3 性能与资源消耗

| 指标 | 数值 | 评估 |
|------|------|------|
| NAS 运行时长 | 25 小时 | 稳定 |
| 数据库记录 | 5 用户, 3316 interactions | 正常 |
| /metrics 数据 | **空**（暂无 LLM 调用） | 待触发 |
| 技能连接率 | 24/82 (29%) | ⚠️ 58 个垃圾技能需清理 |
| 工具总数 | 222 个 | ⚠️ 实际可用远少于此 |

> `/metrics` 中 LLM 指标为 0——因为 NAS 容器未重建，`adapter.ts` 的指标打点未部署。需要触发一次对话后才能采集。

### 2.4 安全与配置

| 检查项 | 状态 | 说明 |
|--------|------|------|
| API Key 加密 | ⚠️ GitHub 已修复，NAS 未部署 | keys.json 仍可能明文 |
| OXOG_ENV_KEY | ✅ GitHub 已配置 | NAS .env 已添加 |
| JWT_SECRET | ⚠️ 默认值散落 7 个文件 | `peppaOS_default_jwt_secret_2026_local` |
| CORS | ⚠️ 完全开放 `*` | 仅适合内网使用 |
| Docker 以 root 运行 | ⚠️ 安全风险 | Dockerfile 未设 USER node |
| 健康检查 | ✅ /health 就绪 | |
| 日志轮转 | ✅ 已配置 max-size 10m | |

### 2.5 数据与存储

| 指标 | 数值 |
|------|------|
| 数据库类型 | SQLite (peppa.db) |
| 用户数 | 5 |
| 对话记录 | 3316 条 |
| agents | 3 |
| Key 配置数 | 8 个（DEEPSEEK/DEEPGRAM/DOUBAO 等） |

> DB 文件大小和知识库大小无法从 API 获取，需要在 NAS 上执行 `ls -lh ~/mayos/data/peppa.db` 确认。

### 2.6 已完成优化有效性验证

| 优化项 | GitHub | NAS 部署 | 验证 |
|--------|--------|---------|------|
| API Key 加密存储 | ✅ | ❌ 未重建 | 待部署 |
| 日志标准化（Pino） | ✅ | ❌ 未重建 | 待部署 |
| 进程健康检查 | ✅ | ❌ 未重建 | 待部署 |
| Prometheus /metrics | ✅ | ❌ 未重建 | LLM 指标为空 |
| 资源感知 MainLoop | ✅ | ❌ 未重建 | 日志无 `[MainLoop]` 记录 |
| 按需工具注入 | ✅ | ❌ 未重建 | 日志无 `[ToolSelector]` 记录 |
| 叙事链+双路召回 | ✅ | ❌ 未重建 | 仅限 server/memory/ |

> **关键发现：所有近期优化均存在于 GitHub（6 个 commit），但在 NAS 运行的是 25 小时前的旧容器。**

## 3. 发现的问题清单

### P0（立即处理）
1. **NAS 未部署所有优化** — 6 个 commit 未生效，需 `git pull && docker compose up -d --build --force-recreate`
2. **82 个技能中 58 个未连接** — 全是 Agent 自动生成的残留，需清理 `mcp_config.json`

### P1（近期处理）
3. **硬编码 JWT 密钥** — 7 处 `peppaOS_default_jwt_secret_2026_local`
4. **Docker root 运行** — 安全风险
5. **CORS 全开 `*`** — NAS 暴露时需收紧

### P2（后续优化）
6. **80+ 空 catch {}** — 错误被静默吞噬
7. **scheduler.ts 1760 行** — 巨型文件
8. **bundled 技能未进镜像** — 每次重建需手动拷贝
9. **5 处 TODO** — 功能缺口

## 4. 改进建议

| 问题 | 建议 | 工作量 |
|------|------|--------|
| NAS 未部署 | `git pull && rebuild` | 10 分钟 |
| 58 个垃圾技能 | 清理 mcp_config.json | 5 分钟 |
| JWT 硬编码 | 统一为单文件导入 | 1 小时 |
| 空 catch | 至少加 logger.error | 2 小时 |
| bundled 不进镜像 | Dockerfile 加 COPY | 5 分钟 |

## 5. 下一步行动建议

1. **立即** — NAS `git pull && docker compose up -d --build --force-recreate`，部署所有优化
2. **然后** — 清理 58 个垃圾技能，mcp_config 从 82 → 15
3. **验证** — 触发一次对话后查看 `/metrics` 和 `[MainLoop]` `[ToolSelector]` 日志
4. **后续** — 按 P0→P1→P2 顺序处理剩余问题
