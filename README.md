# MayOS（Peppa AI）

**浙江灵序科技有限公司 · [lumiai.asia](https://lumiai.asia)**

> MayOS 不是又一个 AI 助手。
>
> 它是第一个真正属于你的 AI 操作系统——从你身上孵化，记忆是你的，人格是你的，存在于你真实的空间里。

---

## 三端形态

| 端 | 位置 | 技术形态 |
|----|------|----------|
| **开发机** | macOS | 源码仓库 + Express 开发服务器（`tsx server.ts`，端口 3000）+ Vite 前端 |
| **NAS 部署** | 群晖/家用 NAS | Docker 容器（`docker-compose.yml`）+ Caddy 反向代理 + Cloudflare 隧道，对外提供 `https://peppaos.qweasd.top` |
| **iOS App** | iPhone | Capacitor 壳（`ios/`），启动时经 `config.json` 远程配置拉取最新 API 域名，免重编译切换域名 |

三端共享同一份数据与人格：个人记忆、关系网络、知识库、技能与语音能力全部由服务器统一承载。

---

## 快速开始（开发机）

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（.env 已存在时跳过；JWT_SECRET 为必需项）
cp .env.example .env

# 3. 启动开发服务器（Express + 前端产物 + Socket.IO + MCP）
npm run dev            # tsx launcher.ts（推荐，含启动自检）

# 4. 浏览器访问
#    http://localhost:3000
```

常用命令：

| 命令 | 作用 |
|------|------|
| `npm run dev` / `npm run dev:direct` | 启动开发服务器（launcher / 直连 server.ts） |
| `npm run build:web` / `build:mobile` / `build:desktop-ui` | 构建对应端前端产物（dist/） |
| `npm run build:server` | 构建服务端产物（dist-server/，`npm run serve` 运行） |
| `npm run lint` | TypeScript 类型检查（`tsc --noEmit`） |
| `npm test` | Vitest 测试套件 |
| `npm run mobile:sync` | 构建移动端产物 + `cap sync` 同步 iOS/Android 壳 |
| `npx cap open ios` | 用 Xcode 打开 iOS 工程 |

---

## 技术栈

- **后端**：Express + TypeScript（tsx 运行），Socket.IO 实时通道，MCP 服务器
- **前端**：React + TypeScript + Vite + Tailwind CSS v4 + Framer Motion
- **移动端**：Capacitor（iOS 壳，`ios/App`），启动时经原生侧 `RemoteConfig` 覆盖服务器地址
- **AI 栈**：多 LLM 提供商（DeepSeek / OpenAI / Anthropic / Gemini / Qwen / Ark / Kimi / GLM / 小米 / Ollama / LM Studio / 自定义 Relay）、GPT-SoVITS / CosyVoice / 豆包语音 TTS、Deepgram / Whisper / Qwen STT

### 实际规模（以仓库文件计）

| 项 | 数量 | 位置 |
|----|------|------|
| 内置技能 | **52** | `server/skills/bundled/` |
| 工具定义 | **42** | `server/tools/definitions/` |
| MCP 内建工具注册 | **10** | `server/mcp/peppa_server.ts` |
| 外部 MCP 服务器（可选） | **3**（filesystem / sqlite / git） | `server/mcp/config.example.json` |
| 服务端模块 | 50+ 目录 | `server/` |

> 数量随仓库演进变化，以上为当前仓库实测值。

---

## 核心能力

- **个人 AI 核心** — 孵化机制、持久记忆（巩固与演化时间线）、关系网络、人格引擎（8 维度连续向量演化 + Jung 认知对约束）
- **技能市场** — 52 个内置技能覆盖电商运营、财税办公、教育教培、企业经营、医疗文书、人事招聘、销售客服、餐饮门店、法律（判例检索/合同审查）、设计（风格模板/图纸）等场景
- **知识库与 RAG** — 文件上传（文档/图片/音视频自动提取）、分块注入 Agent 记忆、语义检索；个人/组织（work 域）双知识库
- **语音交互** — TTS 合成、STT 流式识别、语音唤醒、声纹识别、声音克隆
- **自主能力** — 后台任务、任务链、Peppa Plans、主动问候、环境感知、返回摘要
- **身份与安全** — JWT 认证（`JWT_SECRET` 必需）、声纹+人脸生物识别、订阅分级配额
- **组织协作** — 组织/成员/角色权限、团队知识库、Agent 模板市场、审计日志、企业 IM 接入
- **健康感知** — iOS 原生 HealthKit 接入（心率/HRV/步数），健康感知与个性化服务

---

## NAS 部署

```bash
# 服务器上
docker compose up -d
# → http://<NAS>:3000（HTTP 直连）
# → https://peppaos.qweasd.top（Cloudflare 隧道 → Caddy :80 → 容器 :3000）
```

- `docker-compose.yml` — 容器配置，环境变量从宿主机 `.env` 注入（LLM Key、`JWT_SECRET`、Phase3 自主技能总开关等）
- `Caddyfile` — `:4043` 宿主/公网直连；`:80` 供 Cloudflare 隧道 origin 使用（容器网络内访问）
- **远程配置** — `public/config.json` 提供 `apiBase`，iOS App 启动时拉取以覆盖编译期内嵌域名，服务器换域名只需改此文件，无需重编译 App

---

## iOS App

- 工程：`ios/App`（Capacitor 生成的 Xcode 工程 + CapApp-SPM Swift Package）
- 编译期内嵌地址：`capacitor.config.ts` 的 `server.url`（默认 `https://peppaos.qweasd.top/index.mobile.html`）
- 启动流程：原生侧 `RemoteConfig.swift` 请求 `<内嵌域名>/config.json` → 拿最新 `apiBase` → WebView 加载 `<apiBase>/index.mobile.html`；失败依次回退缓存地址 → 内嵌地址
- 关键文件：
  - `ios/App/App/MayOSBridgeViewController.swift` — 覆盖 `CAPBridgeViewController` 的实例描述符，注入远程配置解析
  - `ios/App/App/RemoteConfig.swift` — 远程配置拉取与缓存
  - `ios/App/App/App.entitlements` — 健康数据等权限声明

---

## 目录结构

```
├── server.ts              # Express 服务器入口（dotenv 最先加载）
├── launcher.ts            # 启动器（自检后拉起 server）
├── routes/                # 顶层路由（files / voice）
├── server/                # 服务端模块（agents/llm/mcp/skills/socket/...）
│   ├── middleware/auth.ts # 统一认证中间件（JWT，必需 JWT_SECRET）
│   ├── mcp/               # MCP 服务器与客户端
│   ├── skills/bundled/    # 52 个内置技能
│   └── tools/definitions/ # 42 个工具定义
├── src/                   # React 前端
├── ios/                   # Capacitor iOS 壳
├── scripts/               # 构建/部署脚本
├── test/                  # Vitest 集成测试
├── public/                # 静态资源（含 config.json 远程配置）
└── docker-compose.yml     # NAS 部署
```

---

## 测试与验证

```bash
npm run lint    # 类型检查
npm test        # 全量测试（vitest run）
```

> 注意：`test/` 中 9 个用例（wake_detector、rtf_extraction、emotional_state 等）在基线提交上即失败，为预存失败，与本仓库近期改动无关。
