# MayOS 项目维护记录

## 概述

MayOS 是从 [PeppaOS](https://github.com/peppaOS) fork 的全栈 AI Agent 项目，经过深度定制，目标是将 MacBook 上的开发版本部署到飞牛 NAS 作为家庭服务器，配合 iPhone、iPad、Apple Watch、手搓小瓦力机器人等多终端使用。

- **愿景**：拥有一个属于自己的、跑在自己硬件上的 AI Agent
- **当前状态**：MacBook 本地开发运行（`localhost:3000`），核心功能（文字对话、语音对话）基本可用
- **下一阶段**：NAS 部署 + 移动终端接入

本文档记录了项目背景、问题排查与修复过程、以及后续的部署规划。

**项目来源时间线：**

| 时间 | 事件 |
|------|------|
| 2026-07-05 | Fork PeppaOS 到自己的 GitHub 帐号 |
| 2026-07-05 | 下载到 MacBook，移除所有 PeppaOS 品牌标识 |
| 2026-07-06 | 修复语音识别（STT）和语音合成（TTS）问题 |
| 2026-07-06 | 修复认证 Token 读取，恢复音色修改功能 |
| 2026-07-06 | 制定 NAS 部署与多终端接入路线图 |

---

## 一、项目架构概览

| 层级 | 技术栈 |
|------|--------|
| 前端 | React + TypeScript + Vite + Tailwind CSS v4 + Framer Motion |
| 后端 | Express (tsx server.ts) 端口 3000 |
| 桌面端 | Tauri v2 (Rust) |
| STT | Deepgram / Qwen-DashScope / Ark-Doubao / OpenAI Whisper / local-whisper |
| TTS | GPT-SoVITS / CosyVoice-DashScope / Ark-Doubao |
| 数据 | SQLite (`~/Peppa/data/peppa.db`) + `~/Peppa/data/keys.json` |

---

## 二、发现的问题与修复

### 问题 1：Safari 下语音对话报 `qwen-asr websocket error`

**现象**：用户在 Safari 以 `http://localhost:3000` 进行语音对话时，提示 `qwen-asr websocket error`。

**根因**：

1. 用户通过 UI 将 STT 偏好设为 `auto`（优先用更稳定的云端方案）
2. `keys.json` 中只配置了 `DASHSCOPE_API_KEY`（阿里云），未配置 `DEEPGRAM_API_KEY` 和 `DOUBAO_SPEECH_KEY`
3. `server/stt/adapter.ts` 中 `getActiveSTTProvider()` 的 auto 模式优先级为：
   - Ark (Doubao) → Deepgram → Qwen → Whisper → local-whisper
4. 由于只有 DashScope Key 可用，auto 模式必然选中 Qwen
5. Qwen ASR 使用 DashScope WebSocket (`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`)，在 Safari 环境下 WebSocket 连接失败

**修复 1**：在 Settings UI 中添加 Deepgram API Key 配置入口

**修改文件**：`src/components/Settings.tsx`（第 1477 行位置）

**修改内容**：在 VoiceServicesPage 组件的语音服务配置区，添加了 Deepgram API Key 字段：

```tsx
<ApiKeyField 
    icon={<Headphones size={18} className="text-blue-400" />} 
    label="Deepgram (STT)" 
    placeholder="Enter Deepgram API key..." 
    storageKey="peppa_deepgram_key" 
    serverKey="DEEPGRAM_API_KEY" 
    hint="High-quality cloud speech recognition. Get your API key at console.deepgram.com. Free credit: $200." 
    t={t} 
/>
```

该字段位于 Doubao Speech 和 DashScope 两个字段之间，与 auto 模式的优先级顺序一致。

> **注**：`Headphones` 图标已在文件顶部 import 中存在，无需额外添加 import。

---

### 问题 2：TTS 不说话 — CosyVoice 免费额度耗尽

**现象**：用户收到阿里云短信提示 `[百炼大模型推理-cosyvoice-v3-flash]` 免费额度耗尽，Peppa 能识别语音但不再出声回应。

**日志特征**：
```
[WARN] [Audio TTS] CosyVoice TTS error (403): The free quota has been exhausted.
```

**根因**：TTS 偏好设置为 `cosyvoice`（DashScope 百炼），其免费额度已用完。

**修复**：用户改为使用豆包（Doubao/Ark）TTS。在 设置 → 语音服务 中将 TTS 切换到 Doubao。

> **前提**：需要正确配置 `DOUBAO_SPEECH_KEY`，格式为 `AppID:AccessToken`（两段用英文冒号连接），可在 [console.volcengine.com/speech](https://console.volcengine.com/speech) 应用管理中获取。

---

### 问题 3：TTS 切换到豆包后仍然不说话

**现象**：TTS 配置已改为 `ark`，`keys.json` 中 `DOUBAO_SPEECH_KEY` 格式正确（`AppID:AccessToken`），但服务器日志仍显示 `CosyVoice TTS error`。

**根因**：`server/tts/providers/ark.ts` 中，豆包 TTS 只支持 6 个固定 voice ID（`BV001_streaming` ~ `BV006_streaming`），但系统默认使用的 voice ID 是 `longxiaochun_v3`（CosyVoice 的语音名）。当 `synthesizeSpeech` 被调用时传入 `voiceId: 'longxiaochun_v3'`，豆包 API 无法识别，导致 TTS 静默失败（在 try-catch 中 TTS 失败后不会让整个流程崩溃，而是静默跳过）。

**修复**：在 Ark TTS provider 中添加 voice ID 自动映射

**修改文件**：`server/tts/providers/ark.ts`（`synthesizeSpeech` 函数内）

**修改内容**：在构建请求体之前，验证 voice ID 是否为有效的豆包语音 ID，如不是则自动回退到 `BV001_streaming`：

```typescript
const { appId, token } = getCredentials();

// Translate non-Doubao voice IDs (e.g. CosyVoice names) to Doubao equivalents
const validVoiceIds = PRESET_VOICES.map(v => v.voiceId);
const mappedVoiceId = validVoiceIds.includes(voiceId) ? voiceId : 'BV001_streaming';

const body: Record<string, any> = {
    app: { appid: appId, cluster: 'volcano_tts' },
    user: { uid: 'peppa_user' },
    audio: {
        voice_type: mappedVoiceId,  // 原先为 voiceId
        encoding: 'mp3',
        rate: 24000,
    },
    // ...
};
```

---

## 三、关键代码路径速查

### STT 流式识别流程

```
前端 useVoiceCall.ts (startCall)
  → 获取麦克风流
  → emit 'audio:start' + 'audio:chunk' (PCM int16 16kHz)
  
服务端 voice.ts (registerVoiceHandlers)
  → 'audio:start' handler
    → getActiveSTTProvider() [server/stt/adapter.ts]
    → createStreamingSession({provider, language, interimResults}) [server/stt/adapter.ts]
    → 注册 onResult / onError 回调
  → 'audio:chunk' handler
    → session.sttSession.sendAudio(chunk)
  → onResult → processVoiceInput() → LLM + Tools + TTS
```

### TTS 合成流程

```
voice.ts processVoiceInput
  → resolveVoiceTtsProvider() [server/tts/adapter.ts]
    → 优先检查 session.currentVoiceProvider
    → 否则调用 getActiveProvider() 读取 DB voice_preference
  → flushSentence() → synthesizeSpeech(text, {provider, voiceId, ...})
  → 前端接收 'audio:response' → Web Audio API 播放
```

### 语音偏好存储

- **存储位置**：`~/Peppa/data/peppa.db` 的 `settings` 表，key = `voice_preference`
- **结构**：`{ "stt": "auto"|"deepgram"|"qwen"|"ark"|"whisper"|"local-whisper", "tts": "auto"|"cosyvoice"|"ark"|"gptsovits" }`
- **读取**：`server/config/voice_preference.ts` 的 `getVoicePreference()`
- **写入**：`server/config/voice_preference.ts` 的 `setVoicePreference()`
- **API 端点**：`POST /api/voice/provider`（前端 VoiceProviderSwitch 组件使用）
- **API Key 存储**：`~/Peppa/data/keys.json`

### STT provider 选择优先级 (auto 模式)

`server/stt/adapter.ts` → `getActiveSTTProvider()`：

1. DOUBAO_SPEECH_KEY 存在 → ark (豆包)
2. DEEPGRAM_API_KEY 存在且电路闭合 → deepgram
3. DASHSCOPE_API_KEY 存在且电路闭合 → qwen
4. DEEPGRAM_API_KEY 存在（忽略电路状态）→ deepgram
5. local-whisper 可用 → local-whisper
6. DASHSCOPE_API_KEY 存在（忽略电路状态）→ qwen
7. OPENAI_API_KEY 存在 → whisper
8. local-whisper（最后兜底）

### TTS provider 选择优先级 (auto 模式)

`server/tts/adapter.ts` → `getActiveProvider()`：

1. hasDoubaoSpeech() → ark (豆包)
2. DASHSCOPE_API_KEY 存在且电路闭合 → cosyvoice
3. GPT-SoVITS 可用 → gptsovits
4. DASHSCOPE_API_KEY 存在（忽略电路状态）→ cosyvoice

---

## 四、已知注意事项

1. **豆包 STT 不支持实时流式**：`server/stt/providers/ark.ts` 仅为 batch 模式（HTTP POST 上传音频文件），不能用于实时语音对话。实时 STT 只能用 Deepgram 或 Qwen。

2. **Qwen WebSocket 可能不稳定**：在 Safari 环境下 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` 可能连接失败。建议优先使用 Deepgram。

3. **CosyVoice 与 DashScope 共享额度**：Qwen ASR 和 CosyVoice TTS 都通过 `DASHSCOPE_API_KEY` 调用阿里云百炼平台，共享同一账号的免费额度。

4. **豆包 TTS 语音 ID 映射**：已添加自动回退逻辑，当 voice ID 不是豆包支持的格式时自动使用 `BV001_streaming`（通用女声）。

5. **前端 TTS 期间不发音频**：`src/hooks/useVoiceCall.ts` 中 TTS 播放期间停止向服务器发送麦克风音频（`isTtsPlaying.current` 检查）。TTS 结束后自动恢复。

6. **Deepgram WebSocket onclose 无错误回调**：`server/stt/providers/deepgram.ts` 的 `ws.onclose` 只记录日志，不触发 `errorCallbacks`。如果 WebSocket 意外断开，上层无法感知。

---

## 五、文件修改清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/components/Settings.tsx:1477` | 新增 | 添加 Deepgram API Key 配置入口 |
| `server/tts/providers/ark.ts` | 修改 | 添加非豆包 voice ID 到 `BV001_streaming` 的自动回退 |
| `server/tts/adapter.ts` | 新增函数 | 新增 `resolveVoiceTtsProvider()` — DB 设置优先，非 auto 模式忽略前端旧 provider |
| `server/tts/adapter.ts` | 修改 | `getActiveProvider()` 不再被直接调用，统一通过 `resolveVoiceTtsProvider` |
| `server/socket/voice.ts` | 修改 | 所有 TTS 调用点改用 `resolveVoiceTtsProvider`（3处） |
| `server/socket/voice.ts` | 新增字段 | AudioSession 新增 `currentVoiceProvider`，接收前端传来的 provider 选择 |
| `server/socket/voice.ts` | 修复 | split 后 `.filter(s => s.trim())` 防止空字符串触发无效 TTS |
| `server/socket/voice.ts` | 新增日志 | TTS provider 选择和合成成功时输出 info 日志 |
| `server/routes/auth.ts` | 修改 | auth 中间件 token 提取逻辑：cookie + Authorization 头双重支持 |
| `test/auth.test.ts` | 新增 | 回归测试：验证 Authorization 头 token 可通过受保护接口 |
| `.env` | 修改 | `JWT_SECRET` 从占位值改为实际开发密钥 |
| `.env.example` | 同步 | 与 `.env` 保持一致 |
| `src/services/authService.ts` | 无改动 | 依赖说明：前端登录时已将 token 写入 localStorage，修复依赖此行为 |

---

## 六、当前配置状态 (2026-07-06)

- **STT**：`deepgram`（Deepgram API Key 已配置）
- **TTS**：`ark`（豆包语音，`DOUBAO_SPEECH_KEY` 已配置为 `AppID:AccessToken` 格式）
- **LLM**：DeepSeek（primary）
- **数据库**：`~/Peppa/data/peppa.db`、`~/Peppa/data/keys.json`

---

## 七、第二次排查：TTS 仍然不说话 (2026-07-06 下午)

### 现象

用户反馈：语音对话只回复文字，完全不出声。之前的修复（voice ID 映射、Deepgram Key 配置等）都已生效，API 调用正常。

### 排查过程

**1. 验证 Doubao API 连通性** — 通过 curl 直接调用 `openspeech.bytedance.com/api/v1/tts`，返回 `code:3000` + 正常音频数据。API 工作正常。

**2. 验证 TTS pipeline** — 编写独立测试脚本直接调用 `synthesizeSpeech`（通过 adapter → ark provider），合成成功（35KB MP3）。服务端 TTS 本身没问题。

**3. 添加调试日志** — 在 `voice.ts` 的 `processVoiceInput` 和 `flushSentence` 关键路径添加日志，写入 `/tmp/peppa_tts_debug.log`。

**4. 捕获到关键日志：**

```
processVoiceInput START:
  ttsProvider=cosyvoice          ← 应该是 ark！
  currentVoiceId=longanwen_v3
  currentVoiceProvider=cosyvoice ← 前端传过来的，覆盖了 DB 设置
  emotionVoiceId=longanwen_v3
  isActive=true

flushSentence SKIP:
  txt="" len=0                   ← 空字符串（split 尾随问题）
  ttsProvider=cosyvoice
```

### 根因

**两个叠加问题导致完全无声：**

#### 问题 A（主要原因）：前端旧 provider 覆盖了 DB 设置

| 层级 | 设置 | 值 | 来源 |
|------|------|-----|------|
| DB（Settings UI） | `voice_preference.tts` | `"ark"` ✅ | 用户在设置页手动切换 |
| 前端 localStorage | `peppa_selected_voice_provider` | `"cosyvoice"` ❌ | 之前选 CosyVoice 语音时固化 |
| Voice Picker | `selectedVoiceProvider` | `"cosyvoice"` ❌ | 从 localStorage 初始化 |
| `audio:start` 事件 | `voiceProvider` | `"cosyvoice"` ❌ | 前端传入 |

**冲突链路：**

```
1. 用户在 Voice Picker 选了 CosyVoice 语音 (longanwen_v3)
   → localStorage['peppa_selected_voice_provider'] = 'cosyvoice'
2. 后来在 Settings → Voice Services 切 TTS 到 Doubao
   → DB voice_preference = {tts:"ark"}
3. 发起语音通话时:
   → 前端 startCall → audio:start {voiceProvider:"cosyvoice"}  ← localStorage 旧值
   → voice.ts resolveVoiceTtsProvider({provider:"cosyvoice"})
   → 旧代码: 直接信任前端，返回 "cosyvoice" ← 跳过 DB 的 "ark"！
   → CosyVoice 免费额度已耗尽（403），TTS 静默失败
   → 文字回复正常（LLM 通路独立），但没有声音
```

**根因代码**（旧 `adapter.ts`）：

```typescript
// 旧 resolveVoiceTtsProvider — 盲目前端选择
export function resolveVoiceTtsProvider(selection) {
  if (selection?.provider) {
    return selection.provider; // ← 不验证，不对比 DB
  }
  return getActiveProvider();  // 只有前端不传时才看 DB
}
```

#### 问题 B（次要）：split 产生空字符串触发无效 TTS

`sentenceBuffer.split(/(?<=[。！？.!?\n])/)` 在文本以标点结尾时会产生尾随空字符串 `""`，该空字符串传入 `flushSentence`，因 `length <= 1` 被跳过。虽不影响功能，但导致了日志中的 `SKIP` 记录。

### 修复

#### 修复 A：DB 设置优先于前端选择

**文件**：`server/tts/adapter.ts`

新增 `resolveVoiceTtsProvider()` 函数，核心逻辑：

```typescript
export function resolveVoiceTtsProvider(selection?) {
  const dbProvider = getActiveProvider();   // 从 DB 读取
  const pref = getVoicePreference();

  // 关键：DB 有明确设置（非 auto）→ 忽略前端，直接用 DB
  if (pref.tts !== 'auto' && dbProvider) {
    return dbProvider;
  }

  // 仅当 DB 是 "auto" 时才参考前端选择（带可用性验证）
  if (selection?.provider) {
    // 验证 credentials...（hasDoubaoSpeech / dashscopeKey / isCircuitClosed）
    // 不满足条件 → 回退到 dbProvider
  }

  return dbProvider;
}
```

**优先级：DB 明确设置 > 前端 auto 模式选择 > 后端 auto 检测 > cosyvoice（兜底）**

#### 修复 B：过滤空字符串

**文件**：`server/socket/voice.ts`

```typescript
// 修复前
const sentences = responseText.split(/(?<=[。！？.!?\n])/);

// 修复后
const sentences = responseText.split(/(?<=[。！？.!?\n])/).filter(s => s.trim());
```

#### 配套修改

`voice.ts` 中所有 TTS 调用点（`processVoiceInput`、proactive speak、greeting）统一从 `getTTSProvider()` 改为 `resolveVoiceTtsProvider({provider: session.currentVoiceProvider})`，同时 `audio:start` 事件新增接收 `voiceProvider` 字段，存入 `session.currentVoiceProvider`。

### 验证

修复后 `resolveVoiceTtsProvider({provider: "cosyvoice"})` 在 DB 设为 `ark` 时返回 `"ark"`，不再被前端旧值覆盖。

---

## 八、经验总结

1. **前端 localStorage 和后端 DB 是两个独立的偏好来源**，需要明确优先级。本次教训：系统级配置（Settings 页面）应优先于 UI 交互级选择（Voice Picker）。

2. **`resolveVoiceTtsProvider` 不应盲目前端选择**。即使前端指定了 provider，也必须验证 credentials 是否存在、circuit breaker 是否闭合。未来若增加新的 provider-specific 验证逻辑，应在此函数中集中管理。

3. **CosyVoice / DashScope 共享额度**。Qwen ASR 和 CosyVoice TTS 都使用 `DASHSCOPE_API_KEY`，若 ASR 消耗大量额度，TTS 也会受影响。建议长期使用 Deepgram（STT）+ 豆包（TTS）组合以解耦。

4. **调试 TTS 静默失败的经验**：TTS 错误被 try-catch 静默吞掉（只写 warn 日志），不会反馈到前端。排查时需要在 `flushSentence` 和 `synthesizeSpeech` 前后加日志才能定位。

---

## 九、认证 Token 读取修复 (2026-07-06)

### 背景

用户反馈无法更改音色。排查发现是因为受保护接口只认 cookie 里的 token，而前端登录后将 token 存入 localStorage，后续请求通过 `Authorization: Bearer xxx` 头部发送。服务端 `auth` 中间件不识别头部 token，导致这些请求被误判为未登录，音色修改等操作失败。

### 涉及的 Token 存储位置

| 存储位置 | 写入方 | 读取方（修复前） | 读取方（修复后） |
|----------|--------|------------------|------------------|
| cookie (`peppa_token`) | 服务端登录响应 Set-Cookie | ✅ auth 中间件 | ✅ 不变 |
| `Authorization: Bearer xxx` 头 | 前端 `authService.ts` → localStorage → 每次请求带上 | ❌ 被忽略 | ✅ auth 中间件新增支持 |
| localStorage (`peppa_auth_token`) | 前端登录后写入 | — | —（前端自己用） |

### 修改内容

#### 1. `server/routes/auth.ts` — 核心修复

auth 中间件的 token 提取逻辑从"只读 cookie"扩展为"cookie + Authorization 头"：

```
修复前:
  token = req.cookies?.lumi_token  // 只认 cookie

修复后:
  token = req.cookies?.lumi_token
       || req.headers.authorization?.replace(/^Bearer /i, '')  // 新增
```

影响的受保护接口：
- `GET /auth/me` — 获取当前用户信息（音色页面依赖此接口验证登录状态）
- `GET /auth/bootstrap` — 登录后初始化数据
- `POST /auth/change-password` — 修改密码
- `POST /auth/switch-org` — 切换组织
- 生物识别相关接口（voiceprint enroll/verify 等）
- `GET /auth/orgs` — 获取组织列表

#### 2. `test/auth.test.ts` — 回归测试

新增测试用例，验证带 `Authorization` 头的请求能正常通过受保护接口，防止同类问题再次出现。

#### 3. `.env` — JWT 密钥修复

```
修复前: JWT_SECRET=peppa-dev-jwt-20260705  (占位值)
修复后: JWT_SECRET=MayOS2024Secret          (实际密钥)
```

确保服务端签发 token 和校验 token 使用同一个密钥，避免签名验证失败。

#### 4. `.env.example` — 同步更新

示例配置文件同步更新，保持与实际 `.env` 一致。

#### 5. `src/services/authService.ts` — 依赖说明

该文件本身逻辑未改动。前端登录流程（`login()` 函数）原本就会把服务端返回的 token 写入：
- `localStorage['peppa_auth_token']` — 前端判断登录状态
- 后续 API 请求通过 `Authorization: Bearer` 头发送

当前修复正是让后端识别这个头部 token。

### 为什么音色修改会受这个影响

```
用户点击更改音色
  → 前端 POST /api/voice/provider  (带 Authorization: Bearer xxx)
  → 后端路由被 auth 中间件拦截
  → 旧代码: 只查 cookie → cookie 里没有 → 401/未登录
  → 前端收到 401 → 操作失败，用户看到"无法更改"
```

修复后，Authorization 头被正确识别，请求正常通过认证，音色修改生效。

### 改前 / 改后对照

**认证通路修复**

| | 改前 | 改后 |
|------|------|------|
| Token 来源 | 只读 `req.cookies.lumi_token` | cookie + `Authorization: Bearer xxx` 头 |
| 前端发 Authorization 头 | 服务端不识别 → 401 | 正常通过认证 |
| 音色修改请求 | 被误判未登录 → 失败 | 正常执行 |

**配置修复**

| | 改前 | 改后 |
|------|------|------|
| JWT_SECRET | `peppa-dev-jwt-20260705`（占位值） | `MayOS2024Secret`（稳定密钥） |
| 签发 & 校验 | 可能不一致（环境差异） | 统一使用同一密钥 |

### 修复归类

```
认证通路修复
├── server/routes/auth.ts    — token 读取：cookie + Authorization 头
└── test/auth.test.ts        — 回归测试：Authorization 头通过受保护接口

配置修复
├── .env                     — JWT_SECRET 改为可用密钥
├── .env.example             — 同步更新
└── src/services/authService.ts — 依赖说明（未改代码，前端存 token 的行为）
```

---

## 十、最终验证结果 (2026-07-06)

两项修复叠加后，语音对话恢复正常：

| 修复 | 解决的问题 | 结果 |
|------|-----------|------|
| `resolveVoiceTtsProvider` DB 优先 | 前端旧 cosyvoice 覆盖 DB 的 ark → TTS 不出声 | ✅ 豆包 TTS 正常合成并播放 |
| auth 中间件识别 Authorization 头 | 音色修改请求被 401 拦截 → 无法改设置 | ✅ 音色可正常切换 |

**最终生效配置**：STT = Deepgram，TTS = 豆包(Ark)，均可正常出声。

---

## 十一、NAS 部署与多终端接入路线图 (2026-07-06)

### 已知现状（全量审计结果）

在制定计划之前，先梳理项目已有和缺失的能力：

| 维度 | ✅ 已具备 | ❌ 缺失 / 需修复 |
|------|----------|-----------------|
| **网络绑定** | `HOST=0.0.0.0`，默认监听所有接口，局域网可直接访问 | — |
| **CORS** | 完全开放，任意 origin 可请求 | 生产环境应收紧 |
| **Docker** | 多阶段 Dockerfile + compose（personal/org 双 profile）+ `/api/health` 健康检查 + 数据卷 | 只构建了 `desktop-ui`；未做多架构（ARM64）；无 HTTPS 反代 |
| **健康检查** | `GET /api/health` 已存在 | — |
| **速率限制** | 登录/注册接口已有（5次/15分钟） | 其他接口无限制 |
| **移动端 UI** | 完整的 React 移动端壳（Tab 导航、语音通话、触觉反馈） | 硬编码 mock 数据；无原生构建目录（`android/`/`ios/` 未生成） |
| **移动端 API** | 复用桌面端 REST + WebSocket | 无移动端专用接口 |
| **Capacitor** | 配置 + npm 依赖 + sync 脚本就绪 | 未 `cap add android/ios` |
| **Tauri** | 桌面端完整（tray、快捷键、系统信息等） | 移动端完全未配置；Rust 代码依赖 PC-only crate |
| **外网访问** | DDNS 转发已配置 ✅ | 需要的是在 NAS 上部署 Caddy 做 HTTPS 反代 |
| **HTTPS** | — | ❌ **严重**：无 TLS。`SameSite=None; Secure` cookie + HTTP = 移动端认证全断 |
| **默认帐号** | 用户名 `peppa`，密码通过 `PEPPA_PASSWORD` 设置（默认 `peppa_2026`） | 生产需改 |
| **JWT_SECRET** | `.env` 中已设为 `MayOS2024Secret` | 生产需换强随机密钥 |
| **日志** | 仅 console 输出（`logger.ts`） | 无文件持久化、无轮转 |

### 目标架构

```
外网 (DDNS 已配置 ✅)
  ↓
路由器端口转发 443 → NAS
  ↓
飞牛 NAS (Linux/Docker)
├── Caddy (HTTPS 反代 + Let's Encrypt 自动证书)
├── MayOS Server (Express + WebSocket)  ← localhost:3000，不对外暴露
│   ├── STT (Deepgram API)
│   ├── LLM (DeepSeek API)
│   └── TTS (Doubao API)
└── SQLite 数据持久化

局域网 / 外网
├── iPhone / iPad   → Safari / PWA
├── Apple Watch     → 通知中继
├── MacBook         → 浏览器 / 桌面客户端
└── 小瓦力机器人     → ESP32 + WiFi
```

### 阶段一：生产化加固（本地 → 可部署）

**目标**：让 MayOS 从"开发模式"变成"可长期稳定运行的服务"。

| # | 任务 | 说明 | 优先级 |
|---|------|------|--------|
| 1.1 | 环境变量统一 | 将所有 API Key 从 `keys.json` 迁移到 `.env`（生产环境不应依赖 UI 写入的文件）。LLM/STT/TTS 的 Key 通过 env 注入 | 🔴 高 |
| 1.2 | Docker 构建目标修正 | 当前 Dockerfile 只构建 `build:desktop-ui`，需改为 `build:web`（通用网页版）或 `build:frontends`（全平台），使容器中托管的是移动端可访问的 web 版本 | 🔴 高 |
| 1.3 | 日志持久化 | 将 `logger.ts` 改为同时写入文件（`data/logs/`），支持按天轮转，方便在 NAS 上排查问题 | 🟡 中 |
| 1.4 | 优雅关闭 | `SIGTERM` 时关闭所有 WebSocket 连接、保存 DB 状态、停止 TTS 播放 | 🟡 中 |
| 1.5 | 非 root 运行 | Docker 容器内使用非 root 用户（`node` 用户），减少安全风险 | 🟢 低 |
| 1.6 | 多架构 Docker 构建 | 确认飞牛 NAS 的 CPU 架构（大概率 x86_64，小概率 ARM64），如需 ARM64 则加 `--platform` 或 buildx | 🔴 高（部署前必须） |

> ✅ 以下已存在无需重复做：`GET /api/health` 端点、auth 接口速率限制。

### 阶段二：Docker 化与 NAS 首次部署

**目标**：在飞牛 NAS 上用 Docker 跑起来，局域网可访问。

| # | 任务 | 说明 | 优先级 |
|---|------|------|--------|
| 2.1 | 飞牛 NAS 环境准备 | SSH 到 NAS，确认 OS 版本、CPU 架构、安装 Docker + Docker Compose | 🔴 高 |
| 2.2 | 完善 Dockerfile | 修正构建目标（见 1.2），确保 `dist/` 包含 web 版前端。生产模式 `NODE_ENV=production` | 🔴 高 |
| 2.3 | 完善 docker-compose.yml | 挂载数据卷 `./data:/app/data`、注入所有 API Key 环境变量、`restart: unless-stopped` | 🔴 高 |
| 2.4 | 首次部署 | `docker-compose up -d`，验证局域网 `http://NAS_IP:3000` 可访问，文字对话可用 | 🔴 高 |
| 2.5 | 数据迁移 | 把 MacBook 上的 `~/Peppa/data/` 拷贝到 NAS 数据卷，验证对话历史不丢失 | 🟡 中 |
| 2.6 | 开机自启 | NAS 开机自动启动 Docker 服务 | 🟡 中 |

### 阶段三：HTTPS 与移动端适配（这两个必须绑定）

**目标**：iPhone/iPad 能正常使用语音对话。

> ⚠️ **这两个阶段必须一起做**。原因：
> 1. iOS Safari 只在 HTTPS 或 localhost 下允许 `getUserMedia`（麦克风）
> 2. 生产模式 cookie 设为 `SameSite=None; Secure`，HTTP 下浏览器拒绝发送 → 认证失败
> 3. 结论：**没有 HTTPS，移动端语音功能和登录认证都会断。**

#### 3.1 反向代理 + HTTPS

| # | 任务 | 说明 | 优先级 |
|---|------|------|--------|
| 3.1.1 | 部署 Caddy | 在 NAS 上 Docker Compose 增加 Caddy 容器，自动 Let's Encrypt 证书 | 🔴 高 |
| 3.1.2 | 配置反向代理 | `mayos.local.example.com → localhost:3000`，Caddy 自动处理 HTTPS | 🔴 高 |
| 3.1.3 | 生产 JWT_SECRET | 更换为强随机密钥（`openssl rand -base64 64`），重新签发所有 token | 🔴 高 |
| 3.1.4 | 收紧 CORS | 将 `*` 改为具体的允许域名（NAS IP、本地域名） | 🟡 中 |
| 3.1.5 | 默认密码修改 | 将 `PEPPA_PASSWORD` 从 `peppa_2026` 改为强密码 | 🟡 中 |

#### 3.2 iPhone / iPad 适配

| # | 任务 | 说明 | 优先级 |
|---|------|------|--------|
| 3.2.1 | 移动端功能测试 | Safari 打开 `https://mayos.local`，逐一测试：登录、文字对话、语音对话、设置 | 🔴 高 |
| 3.2.2 | 修复 MobilePlatform 硬编码数据 | 将 `192.168.1.44` 等假数据替换为实际 NAS IP 或动态检测 | 🔴 高 |
| 3.2.3 | 触控体验优化 | 确保按钮大小 ≥44pt（Apple HIG）、键盘不遮挡输入框、安全区域适配 | 🟡 中 |
| 3.2.4 | PWA 化 | 添加 `manifest.json` + Service Worker → "添加到主屏幕"后像原生 App | 🟡 中 |
| 3.2.5 | Capacitor 原生构建（可选） | `npx cap add ios` → Xcode 编译 → TestFlight 分发。可后续再做 | 🟢 低 |

### 阶段四：外网访问与安全加固

**目标**：DDNS 已通，现在只需要 HTTPS 反代把流量安全地引到 MayOS。

> 当前状态：DDNS 域名 → 路由器端口转发 → NAS。外网已经能访问 NAS，只是 MayOS 还没有接上。

| # | 任务 | 说明 | 优先级 |
|---|------|------|--------|
| 4.1 | 路由器端口转发 443 | 路由器上添加 443 端口转发到 NAS 的 Caddy 端口 | 🔴 高 |
| 4.2 | 收紧 CORS | 将 CORS 从 `*` 改为 DDNS 域名 + 本地 IP 白名单 | 🔴 高 |
| 4.3 | NAS 防火墙 | 仅对外暴露 443（Caddy HTTPS），3000 端口禁止外部访问 | 🟡 中 |
| 4.4 | 备份策略 | Cron 定期备份 `data/` 到 NAS 另一存储池 | 🟢 低 |

> 注意：阶段三已经包含了 Caddy HTTPS 反代的部署（3.1.1-3.1.2），阶段四只需把外网链路的最后两环（路由器 → Caddy）接通。

### 阶段五：扩展终端

**目标**：Apple Watch 和小瓦力机器人接入。

#### 5.1 Apple Watch

| # | 任务 | 说明 | 优先级 |
|---|------|------|--------|
| 5.1.1 | MVP：通知中继 | iPhone 收到 MayOS 回复 → ANCS 推送到 Watch → 语音回复通过 iPhone 麦克风 | 🟡 中 |
| 5.1.2 | 进阶：独立 watchOS App | Swift + WatchConnectivity → iPhone 中转 → MayOS Server | 🟢 低 |

#### 5.2 小瓦力机器人

| # | 任务 | 说明 | 优先级 |
|---|------|------|--------|
| 5.2.1 | 硬件设计 | ESP32 + I2S 麦克风(INMP441) + I2S 喇叭(MAX98357) + WiFi | 🟡 中 |
| 5.2.2 | 通信协议 | ESP32 WebSocket 直连 MayOS Server：上传 PCM 音频 chunk → 接收 TTS MP3 → 本地解码播放 | 🟡 中 |
| 5.2.3 | 唤醒词 | ESP-SR（Espressif Speech Recognition）本地唤醒，或复用前端 MFCC 方案 | 🟢 低 |
| 5.2.4 | 电机控制 | MayOS `client_action` 下发指令 → ESP32 GPIO → 舵机（表情/动作） | 🟢 低 |

### 优先级执行顺序

```
现在应该做         接着做              之后做            最后
─────────         ─────────           ─────────        ─────────
1.1 环境变量      3.1.1 Caddy HTTPS   4.1 端口转发443   5.1 Apple Watch
1.2 Docker 构建   3.1.2 反向代理      4.2 收紧 CORS     5.2 小瓦力
1.6 多架构确认    3.1.3 生产密钥      4.3 NAS 防火墙
2.1 NAS 环境      3.1.4 收紧 CORS     4.4 备份
2.2-2.4 部署      3.1.5 默认密码
                 3.2.1 移动端测试
                 3.2.2 修复硬编码

DDNS 已有的前提下，从"部署到 NAS"到"外网 HTTPS 可用"的路径很短：
  docker-compose up → Caddy 配置 4 行 → 路由器加 443 转发 → 完成
```

### 关键技术决策

| 决策 | 选项 | 建议 | 理由 |
|------|------|------|------|
| 外网访问 | ~~Tailscale / CF Tunnel~~ 已有 DDNS | **DDNS 直接访问** | DDNS + 端口转发已配好，只需加 Caddy HTTPS 反代 |
| HTTPS 反代 | Caddy / Nginx / Traefik | **Caddy** | 自动 Let's Encrypt，配置 4 行搞定；配合 DDNS 域名申请证书 |
| Docker 构建目标 | desktop-ui / web / mobile | **web**（通用） | 桌面和移动都用浏览器打开，web 版本最通用 |
| NAS 架构 | x86_64 / ARM64 | **先确认再改** | 飞牛 NAS 大概率 x86_64，`node:22-slim` 即支持 |
| 移动端方案 | PWA / Capacitor 原生 | **先 PWA** | 零成本、即时更新；DDNS 域名 + HTTPS 天然适合 PWA |

---

## 十二、开发日志

| 日期 | 事件 |
|------|------|
| 2026-07-05 | Fork PeppaOS → 创建 MayOS，完成品牌替换 |
| 2026-07-06 上午 | 修复 STT（Deepgram Key 配置）、TTS voice ID 映射、CosyVoice 额度耗尽 |
| 2026-07-06 下午 | 排查 TTS 不说话的根因：前端旧 provider 覆盖 DB 设置，新增 `resolveVoiceTtsProvider` |
| 2026-07-06 下午 | 修复认证：auth 中间件支持 Authorization 头，恢复音色修改功能 |
| 2026-07-06 傍晚 | 制定 NAS 部署与多终端接入路线图 |
| 2026-07-06 晚上 | 全项目 lumi→peppa 重命名（三轮、300+文件、1600+行）+ 唤醒词加"佩奇" + 文件重命名 + DB 重命名 + TypeScript 编译零错误验证 |
| 2026-07-06 深夜 | 安装 GitHub CLI（gh），推送代码到 julie718/peppaOS（4次提交），获取 workflow token 权限 |
| 2026-07-06 深夜 | 修复人格演化页 `data.history.length` 崩溃：改名后服务器未重启导致 API 404，前端未处理异常响应 |
| 2026-07-06 凌晨 | NAS Docker 部署完成：停旧容器 luvsicos → clone → docker compose up → qweasd.top:3000 可用 |
| 2026-07-06 凌晨 | Caddy HTTPS 部署：NAS 80/443 被飞牛占用改用 4043，运营商封 80 改用自签名证书，macOS 端验证通过 |
| 2026-07-06 凌晨 | 讨论极简手机版方案：Siri 风格界面 + 相机拍照识别 + GPS 位置感知 |
| 2026-07-07 | 简化手机版：mobile.tsx 删掉所有 Tab，只留登录 + AgentChatPage；侧边栏小屏隐藏 |
| 2026-07-07 | 数据持久化：peppa.db 移到绑定目录 ~/mayos/data/，容器重建不丢 |
| ⬜ 待办 | 定时备份：cron 每天自动备份 ~/mayos/data/peppa.db 到 NAS 另一存储位置 |

---

## 十三、全项目 lumi → peppa 重命名 (2026-07-06 晚上)

### 背景

之前改名只改了文件名和部分品牌标识。代码内部、界面文字、类型名中仍大量残留 `lumi`/`Lumi`/`LUMI`，语音对话中显示 "Lumi" 名称。需要系统性重命名。

### 替换规则

| 原 | 新 |
|------|------|
| `LumiOS` | `PeppaOS` |
| `lumiOS` | `peppaOS` |
| `Lumi` | `Peppa` |
| `lumi` | `peppa` |
| `lumi_`（localStorage key 前缀） | `peppa_` |

### 执行方式

编写 `scripts/rename-lumi-to-peppa.mjs` 批量替换脚本：
- 用 `\b` 词边界正则，防止 `volume` → `volpeppa` 等误伤
- 跳过 `node_modules`/`.git`/`.claude`/`dist`
- 先 dry-run 审核 → 确认无误 → 执行

### 三轮改动

**第一轮：批量脚本**
- 274 文件、1466 行
- `\b` 词边界无法匹配下划线连接词（`lumi_xxx`）、连写词（`LumiAI`）、文件路径中的名称
- 用额外规则 `'lumi_` → `'peppa_` 等补充

**第二轮：手动修漏网之鱼**
- 用户可见文字：`LUMI BIOS` → `MAYOS BIOS`、`lumiai.asia` → `mayos.asia`、`LUMI_WALLS` → `MAYOS_WALLS`、`LumiCAD` → `MayCAD`
- JWT 硬编码密钥：5处 `lumiOS_default_jwt_secret_2026_local` → `peppaOS_default_jwt_secret_2026_local`
- TypeScript 类型/函数：`LumiPlan` → `PeppaPlan`、`createLumiMcpServer` → `createPeppaMcpServer`、`getLumiPersonalityConstitution` → `getPeppaPersonalityConstitution` 等 40+处

**第三轮：TypeScript 编译验证**
- `npx tsc --noEmit` **零错误** — 所有 TypeScript 类型引用自动校验通过

### 文件重命名

| 原 | 新 |
|------|------|
| `lumi_model_config_schema.json` | `peppa_model_config_schema.json` |
| `lumi_model_config_example.json` | `peppa_model_config_example.json` |
| `assets/lumiOS-icon.svg` | `assets/peppaOS-icon.svg` |
| `server/mcp/lumi_server.ts` | `server/mcp/peppa_server.ts` |
| `~/Peppa/data/lumi.db` | `~/Peppa/data/peppa.db` |

### 唤醒词更新

`server/stt/wake_detector.ts` 清理后：

- 英文：`Peppa`、`peppa`、`PEPPA` + 嘿/嗨/hey/hi 前缀变体
- 中文：`佩奇`、`佩琦`、`佩琪`、`佩齐` + 前缀变体
- 保留：`Jarvis`、`贾维斯`、`计算机`、`电脑`、`豆包`系列
- 移除：`卢米`/`路米`/`鲁米`/`露米`（旧 Lumi 中文音译）

### 故意未改的两类

| 类别 | 原因 | 数量 |
|------|------|------|
| 环境变量名（`LUMI_DATA_DIR`、`LUMI_ROLE` 等） | 改动会破坏已有 `.env`/`docker-compose.yml` 配置，等 NAS 部署时统一改 | 12处 |
| 翻译 key（`lumiNexusTitle`、`lumiCore` 等） | key 是内部标识，用户看到的 value 已是 Peppa；改动需同时改所有引用，漏一处就显示空白 | 20+处 |

### 影响

- 浏览器 localStorage key 全部变了（`peppa_auth_token` 替代 `lumi_auth_token`），需重新登录
- DB 文件已重命名，重启服务器正常读取

---

## 十四、GitHub 推送 (2026-07-06 深夜)

### 背景

之前代码一直在 MacBook 本地，远程仓库地址是旧的 `--May-OS`。改名完成后需要推到新的 `peppaOS` 仓库。

### 操作步骤

1. **更换 remote** — `origin` 从 `julie718/--May-OS` 改为 `julie718/peppaOS`
2. **安装 GitHub CLI** — MacBook 没装 Homebrew，直接从 GitHub Release 下载 arm64 二进制到 `~/bin/gh`
3. **登录认证** — `gh auth login`，走 device flow，浏览器输入验证码
4. **遇到障碍** — token 缺 `workflow` 权限，GitHub 拒绝推送 `.github/workflows/ci.yml`
5. **修复** — `gh auth refresh -s workflow` 补权
6. **推送** — 347 文件、3330 增 2195 删，成功推到 main 分支

### 仓库信息

| 项目 | 值 |
|------|-----|
| 地址 | https://github.com/julie718/peppaOS |
| 分支 | main |
| 提交数 | 3（品牌备份 + 全项目重命名 + ci.yml 补推） |
| GitHub CLI | `~/bin/gh`，PATH 已配置到 `~/.zshrc` |

---

## 十五、人格演化页崩溃修复 (2026-07-06 深夜)

### 现象

底部 Docker 栏点击「人格设定」，页面显示"信号中断"，控制台报错：

```
undefined is not an object (evaluating 'data.history.length')
```

### 根因

两层问题叠加：

**1. 运行时问题：服务器未重启**

改名脚本把 `personalities.json` 的 `"id": "lumi"` → `"id": "peppa"`。但服务器一直没重启，内存中 `personalityRegistry` 还是旧数据。前端请求 `/api/personality/peppa/evolution` 时，注册表找不到 `peppa`，返回 404 `{"error":"Personality not found"}`。

→ **解决**：重启服务器（`kill` + launcher 自动重启）

**2. 代码问题：前端未处理 API 异常响应**

`PersonalityEvolution.tsx:152-155`：

```typescript
fetch(`/api/personality/${personalityId}/evolution`)
    .then(r => r.json())
    .then(d => { setData(d); ... })  // ← 404 时 d = {error:"..."}
    .catch(...)                        // ← fetch 404 不抛异常，catch 不到
```

404 的 `{error: "Personality not found"}` 被 `setData` 设置成了组件状态。然后第 243 行：

```typescript
const hasHistory = data && data.history.length > 0;
//                    ^^^^        ^^^^^^^^^^^^
//                   data 存在    history 是 undefined → TypeError
```

### 修复

**文件**：`src/components/PersonalityEvolution.tsx`

**修 1**（第 153-156 行）：增加 API 错误响应拦截

```diff
- .then(d => { setData(d); setSelectedStep(d.history?.length > 0 ? 0 : null); })
+ .then(d => {
+   if (d.error) { toast.error(d.error); return; }
+   setData(d);
+   setSelectedStep(d.history?.length > 0 ? 0 : null);
+ })
```

**修 2**（第 243 行）：增加 history 空值保护

```diff
- const hasHistory = data && data.history.length > 0;
+ const hasHistory = data && data.history && data.history.length > 0;
```

已提交并推送至 GitHub。

---

## 十六、飞牛 NAS Docker 部署 (2026-07-06 深夜)

### 目标

将 MayOS 从 MacBook 开发环境迁移到飞牛 NAS，通过 Docker 运行，局域网 + DDNS 外网可访问。

### NAS 环境

| 项目 | 值 |
|------|-----|
| 主机名 | ray |
| 架构 | x86_64 |
| Docker Compose | v2.40.3 |
| 域名 | qweasd.top |
| SSH 端口 | 4041 |
| 公网 IP | 61.137.129.194 |

### 部署步骤

**1. 停掉旧容器，释放 3000 端口**

```bash
docker stop luvsicos && docker rm luvsicos
```

**2. 克隆项目**

```bash
git clone https://github.com/julie718/peppaOS.git mayos
cd mayos
```

**3. 创建 .env 文件**

写入 DEEPSEEK_API_KEY、DEEPGRAM_API_KEY、DOUBAO_SPEECH_KEY、DASHSCOPE_API_KEY、JWT_SECRET、PEPPA_PASSWORD 等环境变量。

**4. 构建镜像并启动**

```bash
docker compose up -d --build
```

- 构建时间：约 3 分钟（npm ci + vite build:frontends + esbuild server）
- 镜像大小：约 3GB
- 服务端口：3000
- 健康检查：`GET /api/health`，每 30 秒一次

**5. 验证**

```bash
docker compose ps
# STATUS: Up (healthy)

curl http://qweasd.top:3000
# 返回 MayOS 登录页面 HTML
```

### Docker 配置

**Dockerfile** 改为多前端构建（`build:frontends`），同时托管桌面版、网页版、移动版。

**docker-compose.yml** 精简为单容器（personal 模式），补齐所有 API Key 环境变量。

### NAS 上的其他容器

| 容器 | 端口 | 用途 | 状态 |
|------|------|------|------|
| mayos | 3000 | ✅ 当前 | 新增 |
| hermes | 8000 | AI agent | 保留 |
| homeassistant | 8123 | 智能家居 | 保留 |
| luvsicos | 3000 | 旧 MayOS/LumiOS | 已删除 |

### 额外修复

飞牛 NAS 自带 nginx 占用 80 和 443 端口。国内运营商封锁 80 端口的入站连接，导致 Let's Encrypt HTTP 验证失败。

解决方案：**Caddy 自签名证书**

---

## 十七、HTTPS 接入 (2026-07-06 凌晨)

### 问题

| 问题 | 原因 |
|------|------|
| 飞牛 NAS 的 80 和 443 已被自带 nginx 占用 | 飞牛管理界面 |
| 运营商封锁 80 端口入站连接 | 中国大陆政策 |
| Let's Encrypt 证书验证失败 | 两种验证方式均走不通 |

### 方案

Caddy 绑定 4043 端口，用 `tls internal` 生成自签名证书。

**Caddyfile：**

```
{
    http_port 4080
    https_port 4043
}

qweasd.top:4043 {
    tls internal
    reverse_proxy mayos:3000
}
```

**docker-compose.yml** caddy 部分：

```yaml
caddy:
  image: caddy:2-alpine
  container_name: caddy
  ports:
    - "4043:4043"
  volumes:
    - ./Caddyfile:/etc/caddy/Caddyfile:ro
    - caddy_data:/data
  restart: unless-stopped
```

### 验证

- MacBook 浏览器：`https://qweasd.top:4043` ✅
- 自签名证书 → 浏览器提示"不安全" → 手动信任即可
- HTTPS + iOS Safari → 麦克风权限可用 ✅

### 当前访问入口

| URL | 协议 | 用途 |
|------|------|------|
| `https://qweasd.top:4043` | HTTPS | 移动端（支持麦克风） |
| `http://qweasd.top:3000` | HTTP | 电脑端调试 |

---

## 十八、iPhone 硬件能力利用计划

### 优先级总览

| 优先级 | 功能 | 硬件 | 实现难度 | 使用场景举例 |
|--------|------|------|----------|-------------|
| 🔴 P0 | 拍照识别 | 后置摄像头 | 🟢 低 | 拍菜单翻译、拍植物识别、拍物体问"这是什么" |
| 🔴 P0 | GPS 位置感知 | GPS | 🟡 中 | 到家自动问候、在超市提醒清单、附近推荐 |
| 🔴 P0 | 环境感知 | 光线+加速计+时间 | 🟢 低 | 晚上躺下→轻声、白天户外→简短语音 |
| 🟡 P1 | 运动状态感知 | 加速计 | 🟢 低 | 走路→语音播报、静止→屏幕文字、开车→勿扰 |
| 🟡 P1 | 推送通知 | Notification API | 🟡 中 | 主动提醒：天气、日程、长期不说话时问候 |
| 🟡 P1 | 3D 拍照估算尺寸 | 后置+视觉模型 | 🟢 低 | 拍家具→"高30cm宽50cm距你1.2米" |
| 🟢 P2 | 指南针朝向 | 磁力计 | 🟢 低 | 你对着北方→知道你在看什么方向 |
| 🟢 P2 | 电池感知 | Battery API | 🟢 低 | 低电量时少说话、关闭非必要功能 |
| 🟢 P2 | 剪贴板同步 | Clipboard API | 🟢 低 | 电脑复制→手机粘贴，跨设备传文字 |
| ⬜ P3 | LiDAR 3D 扫描 | LiDAR | 🔴 需原生App | 室内建模、AR测量（Safari做不了，需App） |

### 场景举例

**场景 1：周末早上在家**
```
光线亮 + 静止 + GPS 在家 + 早上9点
→ "早上好！今天天气不错，要给你念今天的新闻吗？"
```

**场景 2：晚上躺床上**
```
光线暗 + 静止 + 晚上11点 + 水平拿手机
→ "睡不着吗？要不要给你读段睡前故事？"（轻声）
```

**场景 3：走进超市**
```
GPS 在超市 + 走路状态
→ "需要我帮你记住购物清单吗？"
```

**场景 4：对着看不懂的菜单**
```
拍照 → 视觉模型识别
→ "这道是法式油封鸭腿，180元。需要我推荐搭配吗？"
```

**场景 5：拍家具量尺寸**
```
拍照 + AI 估算
→ "高30cm，宽50cm，距你1.2米。需要我帮你算房间布局吗？"
```

### 当前聊天界面需调整

登录后目前使用桌面版 `AgentChatPage`，手机端需替换为专用 `MobileChat` 组件。

**底部输入栏 — 极简设计：**

只需两个元素，其他功能全收进麦克风按钮的长按菜单：

```
┌─────────────────────────────────────┐
│ [ 输入消息...                    ] [🎤] │
└─────────────────────────────────────┘
```

**长按麦克风弹出子菜单：**

```
┌─────────────────┐
│ 🎤 实时通话      │  点开一直聊，像打电话
│ 📻 对讲         │  按住说话，松开发送
│ 📷 拍照识别      │  拍物体+估算尺寸
│ 📐 3D扫描       │  LiDAR（需原生App，远期）
└─────────────────┘
```

**被动感知（无需按钮）：**

| 传感器 | 自动感知 | MayOS 自适应 |
|--------|----------|-------------|
| GPS | 在家/公司/户外 | 回复内容场景化 |
| 光线 | 白天/夜间 | 夜间轻声、文字为主 |
| 加速计 | 走路/开车/静止 | 开车少说、走路语音播报 |
| 时间 | 早上/深夜 | 深夜不主动打扰 |
| 电池 | 电量 | 低电量关非必要功能 |

### 执行顺序

```
现在：
  1. MobileChat 组件 → 替换 AgentChatPage（聊天界面）
  2. 相机拍照识别 → 接入现有视觉模型后端

接着：
  3. GPS 位置感知 → 后端新增位置上下文
  4. 环境感知 → 光线+时间自动调节回复方式

之后：
  5-8. 推送通知、运动感知、指南针、电池
```