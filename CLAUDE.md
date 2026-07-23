# Peppa Project Skills

## ⚠️ 提交前必验证
**改完任何代码并部署到 NAS 后，必须主动验证功能是否生效。** 不等用户反馈、不靠 Agent 回复判断。验证方式：调用对应 API、查看日志、确认工具注册。验证通过才算做完。

## /dev — Start development environment
Start the Node.js dev server (if not running) and launch the Tauri desktop app.
```
1. Check if port 3000 is in use — if not, run `tsx server.ts` in background
2. Wait for server ready signal
3. Run `d:/peppaOS/src-tauri/target/debug/peppa-os.exe` in background
4. Confirm both processes are running
```

## /check — Quick type-check
Run TypeScript compiler with noEmit to verify frontend code.
```
npx tsc --noEmit
```

## /build — Full verification
Run type-check, then verify Rust backend compiles.
```
1. npx tsc --noEmit
2. cd src-tauri && cargo build
```

## Project Context
- **Frontend**: React + TypeScript + Vite + Tailwind CSS v4 + Framer Motion
- **Backend**: Express (tsx server.ts) on port 3000
- **Desktop**: Tauri v2 with WebView2, Rust backend
- **AI Stack**: 5 LLM providers, GPT-SoVITS TTS, Deepgram STT, MCP ecosystem (27 tools)
- **Dev URL**: http://localhost:3000 (WebView2 connects to Vite dev server)
- **Tauri binary**: src-tauri/target/debug/peppa-os.exe
