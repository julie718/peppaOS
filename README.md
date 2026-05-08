# LumiOS

Sustainable Evolving AI Personality Operating System — an all-in-one AI desktop companion with persistent memory, multi-model intelligence, and voice interaction.

## Features

- **Multi-LLM Engine** — OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen/DashScope
- **Voice Interaction** — GPT-SoVITS, CosyVoice, ElevenLabs, FishAudio TTS + Deepgram/Whisper STT
- **MCP Ecosystem** — 27+ tools via Model Context Protocol for file ops, web, desktop automation
- **Persistent Memory** — Long-term memory store with consolidation and evolution timeline
- **Personality Engine** — Configurable AI personality with behavior registry
- **Skill Marketplace** — Installable community skills for extensibility
- **Device Sync** — Cross-device state and memory synchronization

## Platforms

| Platform | Status |
|---|---|
| Windows Desktop (Tauri v2 + WebView2) | Main target |
| Web (React SPA) | Included |
| Mobile (Capacitor iOS/Android) | Experimental |

## Tech Stack

**Frontend:** React 19, TypeScript, Tailwind CSS v4, Vite, Framer Motion  
**Backend:** Node.js, Express, Socket.io, SQLite3  
**Desktop:** Tauri v2 (Rust), WebView2  
**AI:** 5 LLM providers, MCP SDK, GPT-SoVITS, Deepgram, CosyVoice  

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# In another terminal, start desktop app
npm run tauri:dev
```

The dev server runs on `http://localhost:3000`. The Tauri desktop app connects to it automatically.

## Project Structure

```
src/              React frontend (shared across desktop/web/mobile)
src-tauri/        Tauri v2 desktop shell (Rust)
server/           Express backend (LLM, MCP, memory, TTS, STT, personality)
server.ts         Backend entry point
routes/           API route handlers
scripts/          Build scripts
```

## Build

```bash
# Full desktop build (frontend + backend + resources)
npm run build:desktop

# Type-check
npm run lint

# Tests
npm run test
```

## License

GNU Affero General Public License v3.0 (AGPL-3.0).  
See [LICENSE](./LICENSE) for full text.

**TL;DR:** Free for personal use, modification, and redistribution. If you use it commercially in a network-facing service, you must open source your modifications under the same license. For commercial closed-source licenses, contact the copyright holder.
