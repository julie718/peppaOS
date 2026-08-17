# MayOS Project

个人 AI 操作系统（Peppa AI）。仓库在 Mac 上开发，服务端部署到 NAS，客户端为 iOS App。

## ⚠️ 提交前必验证
**改完任何代码后，必须主动验证功能是否生效。** 不等用户反馈、不靠 Agent 回复判断。验证方式：调用对应 API、查看日志、确认工具注册、运行测试。验证通过才算做完。

## /dev — Start development environment
Start the Node.js dev server (if not running).
```
1. Check if port 3000 is in use — if not, run `npx tsx server.ts` in background
2. Wait for health endpoint (`curl http://localhost:3000/api/health`) to return 200
3. Confirm the server process is running
```

## /check — Quick type-check
Run TypeScript compiler with noEmit to verify code.
```
npx tsc --noEmit
```

## /build — Full verification
Type-check, then run the test suite.
```
1. npx tsc --noEmit
2. npx vitest run
```

## Project Context
- **Frontend**: React + TypeScript + Vite + Tailwind CSS v4 + Framer Motion
- **Backend**: Express (tsx server.ts) on port 3000, Socket.IO, MCP server
- **Mobile**: Capacitor iOS shell (ios/App) — 启动时 RemoteConfig.swift 拉取 config.json 覆盖 API 域名
- **Deployment**: NAS Docker (docker-compose.yml) + Caddy 反向代理 + Cloudflare 隧道 → https://peppaos.qweasd.top
- **AI Stack**: 12 LLM providers, GPT-SoVITS/CosyVoice/豆包 TTS, Deepgram/Whisper/Qwen STT, MCP ecosystem (52 skills, 42 tool definitions)
- **Dev URL**: http://localhost:3000
- **Auth**: JWT（`JWT_SECRET` 环境变量必需，无兜底密钥；缺失时服务启动即失败）

## 重要约定
- iOS 修改后必须 `npx cap sync` 并核对 `ios/App/CapApp-SPM/Package.swift` 中 health 插件包名（cap sync 可能改写成 KrzysztofkosteckiCapacitorHealth，需手动恢复为 CapgoCapacitorHealth）
- 验证 iOS 编译：`xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`
- 服务器改域名：只改 `public/config.json` 的 apiBase，无需重编译 App
- `routes/files.ts` 与 `server/middleware/auth.ts` 使用统一 JWT 校验，均不设兜底密钥
