// Peppa Unified Server
// / → personal AI OS desktop
// /index.org.html → org workbench (create/manage orgs, legal tools)
import "dotenv/config";

// ── 全局类型声明 ──
declare global {
  var __activeSessionId: string;
  var __wsClients: Array<{ sessionId: string; ws: any }>;
  var __lastUserMessageAt: number;
}

import { setIO } from './server/lib/pushService';

// ── Required environment variables ──
// P1-4 说明：JWT_SECRET 缺失属启动前配置错误，此处 throw（此时全局异常处理器
// 尚未注册，进程以未捕获异常自然退出 = 显式 fail-fast，非全局猝死逻辑）。
if (!process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is required. Set it in .env or docker-compose.yml.');
  throw new Error('JWT_SECRET is required. Set it in .env or docker-compose.yml.');
}

// ── Global exception handlers (must be first — before any async setup) ──
import { logger } from './server/lib/logger';

// P1-4 废除全局暴力 process.exit：单次未捕获异常/拒绝不再猝死整个服务
//（修复前 setTimeout(process.exit, 1000) 使任何后台任务的偶发异常都导致
//  容器重启/对话中断/内存脏数据丢失）。
// 现在：记录完整堆栈 + 尽力落盘（5s 节流），服务保持存活；反复崩溃由
// launcher 的 crash-retry 层（launcher.ts handleFatalCrashes）兜底判定重启。
let lastCrashFlushAt = 0;
async function flushDBBestEffort(): Promise<void> {
  try {
    if (Date.now() - lastCrashFlushAt < 5000) return; // 崩溃风暴节流
    lastCrashFlushAt = Date.now();
    const { flushDB } = await import('./db_layer');
    await flushDB();
  } catch {}
}
process.on('uncaughtException', (err) => {
  logger.error('[FATAL] Uncaught exception（服务保持存活）:', err.message, err.stack);
  void flushDBBestEffort();
});
process.on('unhandledRejection', (reason) => {
  const stack = reason instanceof Error ? reason.stack : '';
  logger.error('[FATAL] Unhandled rejection（服务保持存活）:', String(reason), stack);
  void flushDBBestEffort();
});

import { fileURLToPath } from "url";
import path from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import express from "express";
import { createApp } from "./server/runtime/core";
import { createLLMRuntime } from "./server/runtime/llm";
import { mountAllRoutes } from "./server/runtime/routes";
import { initSocketRuntime } from "./server/runtime/socket";
import { setupMcpServer } from "./server/runtime/mcp_server";
import { setupMessaging } from "./server/runtime/messaging";
import { setupStatic } from "./server/runtime/static";
import { bootstrap } from "./server/runtime/bootstrap";
import { lapRoutes } from "./server/lap/routes";
import voiceRoutes from "./routes/voice";
import fileRoutes, { configureKnowledgeFileRoutes } from "./routes/files";
import { subscriptionRoutes } from "./server/subscription/routes";
import { handleHealthData } from './server/api/health.js';
import { resolveRole } from "./server/runtime/role";
// import { getDesireEngine } from './server/desire/engine.js'; // 已停用 — 数字生命体接管
import { getLifeSystem } from './server/life/index.js';
import { logParadigmPhase0Status } from './src/utils/paradigmGuard';
import { registerDataSources } from './server/lib/dataSourceRegistry.js';
// Phase2 模块1：感知事件队列（内存队列 + SQLite 后备表 + 空闲回捞 + 超时丢弃）
import { startPerceptionQueueMaintenance } from './server/perception/queue';
// Phase-3 总入口（server/phase3 为本地未提交实验模块，Docker 构建环境不存在 → 已注释停用，后续开发取消注释即可）
// import { initPhase3 } from './server/phase3';
import {
  configureNcmCredentials,
  normalizeNcmAppId as normalizeStoredNcmAppId,
  normalizeNcmPrivateKey as normalizeStoredNcmPrivateKey,
  runNcmCliAsync as runStoredNcmCli,
} from "./server/music/ncm_cli";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROLE = resolveRole();

const { app, server, io, apiRouter, PORT, HOST, JWT_SECRET, getCookieOptions } = createApp();
setIO(io);
(global as any).__wsClients = (global as any).__wsClients || [];
(global as any).__lastUserMessageAt = 0;
const llm = createLLMRuntime();

// ── Static serve for lumi_output (charts, images, generated files) ──
app.use('/peppa_output', express.static(path.join(process.cwd(), 'peppa_output')));

// ── Shared routes (both roles) ──
mountAllRoutes({ apiRouter, jwtSecret: JWT_SECRET, llm, getCookieOptions, io });
configureKnowledgeFileRoutes({
  llmGetters: {
    getDeepSeek: llm.getDeepSeek,
    getGemini: llm.getGemini,
    getOpenAI: llm.getOpenAI,
    getAnthropic: llm.getAnthropic,
    getQwen: llm.getQwen,
    getOllama: llm.getOllama,
    getLmStudio: llm.getLmStudio,
    getArk: llm.getArk,
    getXiaomi: llm.getXiaomi,
    getKimi: llm.getKimi,
    getGlm: llm.getGlm,
    getRelay: llm.getRelay,
  },
});
apiRouter.use("/", voiceRoutes);
apiRouter.use("/", fileRoutes);
apiRouter.use("/", subscriptionRoutes);
apiRouter.use("/", lapRoutes);
apiRouter.put('/health/data', handleHealthData);

// ── NetEase ncm-cli login ──
let ncmLoginPolling: ReturnType<typeof setTimeout> | null = null;
let ncmLoginQrUrl: string | null = null;
let ncmLoginDone = false;
const execFileP = promisify(execFile);

async function runNcmCli(args: string[], timeout = 15000): Promise<{ stdout: string; stderr: string }> {
  const result = await runStoredNcmCli(args, timeout);
  if (!result.ok) throw new Error(result.error || result.stderr || result.stdout || 'ncm-cli failed');
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}
async function checkNcmLoginStatus(timeout = 8000): Promise<boolean> {
  try {
    const check = await runNcmCli(['login', '--check', '--output', 'json'], timeout);
    const data = JSON.parse(check.stdout || '{}');
    ncmLoginDone = isNcmLoggedInPayload(data);
    if (ncmLoginDone) {
      ncmLoginQrUrl = null;
      if (ncmLoginPolling) {
        clearInterval(ncmLoginPolling);
        ncmLoginPolling = null;
      }
    }
  } catch {
    // Keep the last known in-memory state if ncm-cli cannot answer right now.
  }
  return ncmLoginDone;
}

function extractNcmQrUrl(data: any): string | null {
  return data?.qrCodeUrl
    || data?.clickableUrl
    || data?.qrUrl
    || data?.url
    || data?.data?.qrCodeUrl
    || data?.data?.clickableUrl
    || data?.data?.qrUrl
    || data?.data?.url
    || null;
}

function isNcmLoggedInPayload(data: any): boolean {
  return Boolean(
    data?.success
    || data?.done
    || data?.loggedIn
    || data?.isLogin
    || data?.login
    || data?.data?.success
    || data?.data?.done
    || data?.data?.loggedIn
    || data?.data?.isLogin
    || data?.data?.profile
    || data?.account
    || data?.profile,
  );
}

async function syncStoredNcmCredentials(timeout = 10000): Promise<{ ok: boolean; error?: string }> {
  try {
    const { getKey } = await import('./server/config/keys');
    const appId = normalizeStoredNcmAppId(getKey('NETEASE_APP_ID'));
    const privateKey = normalizeStoredNcmPrivateKey(getKey('NETEASE_PRIVATE_KEY'));
    if (!appId || !privateKey) return { ok: false, error: 'NetEase credentials are not saved.' };
    await configureNcmCredentials(appId, privateKey, timeout);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Configure ncm-cli credentials (appId + privateKey from developer.music.163.com)
apiRouter.post('/ncm/configure', async (req, res) => {
  try {
    const { appId, privateKey } = req.body || {};
    const safeAppId = normalizeStoredNcmAppId(appId);
    const safePrivateKey = normalizeStoredNcmPrivateKey(privateKey);
    if (!safeAppId || !safePrivateKey) {
      return res.json({ success: false, error: 'appId and privateKey are required' });
    }
    await configureNcmCredentials(safeAppId, safePrivateKey, 10000);
    const { saveKeys } = await import('./server/config/keys');
    saveKeys({ NETEASE_APP_ID: safeAppId, NETEASE_PRIVATE_KEY: safePrivateKey });
    console.log('[NCM] Credentials configured.');
    res.json({ success: true });
  } catch (e: any) {
    res.json({ success: false, error: e.message || String(e) });
  }
});

apiRouter.get('/ncm/configure/status', async (_req, res) => {
  let hasStoredKeys = false;
  let syncError = '';
  try {
    const { getKey } = await import('./server/config/keys');
    const appId = normalizeStoredNcmAppId(getKey('NETEASE_APP_ID'));
    const privateKey = normalizeStoredNcmPrivateKey(getKey('NETEASE_PRIVATE_KEY'));
    hasStoredKeys = Boolean(appId && privateKey);
    if (appId && privateKey) {
      const synced = await syncStoredNcmCredentials(10000);
      if (!synced.ok) {
        syncError = synced.error || '';
        console.warn('[NCM] Stored credentials exist but ncm-cli configure failed:', syncError);
      }
    }
    const envConfigured = Boolean(
      normalizeStoredNcmAppId(process.env.NETEASE_APP_ID)
      && normalizeStoredNcmPrivateKey(process.env.NETEASE_PRIVATE_KEY),
    );
    res.json({
      configured: hasStoredKeys || envConfigured,
      synced: envConfigured && !syncError,
      error: syncError || undefined,
    });
  } catch {
    res.json({ configured: hasStoredKeys, synced: false, error: syncError || undefined });
  }
});

apiRouter.post('/ncm/login', async (_req, res) => {
  try {
    const synced = await syncStoredNcmCredentials(10000);
    if (!synced.ok) console.warn('[NCM] Login requested before credentials synced:', synced.error);
    if (await checkNcmLoginStatus(8000)) {
      return res.json({ success: true, done: true, qrUrl: null });
    }
    const result = await runNcmCli(['login', '--background', '--output', 'json'], 15000);
    const data = JSON.parse(result.stdout || '{}');
    ncmLoginQrUrl = extractNcmQrUrl(data);
    if (!ncmLoginQrUrl) {
      return res.json({
        success: false,
        done: false,
        error: data.message || data.error || 'NetEase login did not return a QR URL.',
      });
    }
    ncmLoginDone = false;

    // Poll login status every 3s
    if (ncmLoginPolling) clearInterval(ncmLoginPolling);
    ncmLoginPolling = setInterval(async () => {
      try {
        await checkNcmLoginStatus(8000);
      } catch {}
    }, 3000);

    res.json({ success: true, qrUrl: ncmLoginQrUrl });
  } catch (e: any) {
    res.json({ success: false, error: e.message || String(e) });
  }
});

// On startup: configure ncm-cli (mpv path + credentials), then check login
(async () => {
  try {
    const fs = await import('fs');

    // Configure mpv player path so ncm-cli can find it
    const mpvPath = process.env.MPV_PATH
      || (fs.existsSync('C:/Program Files/MPV Player/mpv.exe') ? 'C:/Program Files/MPV Player/mpv.exe' : 'mpv');
    await runNcmCli(['config', 'set', 'player', mpvPath], 10000).catch(() => {});
    console.log(`[NCM] Player configured: ${mpvPath}`);

    await syncStoredNcmCredentials(10000).catch(() => {});
    if (await checkNcmLoginStatus(10000)) {
      console.log('[NCM] Already logged in from previous session.');
    }
  } catch {}
})();

// ── Auto-detect mpv for ncm-cli playback ──
(async () => {
  const fs = await import('fs');
  try {
    // Check if mpv is already configured
    const { stdout: existingPlayer } = await runNcmCli(['config', 'get', 'player'], 8000);
    if (existingPlayer.includes('mpv') || existingPlayer.includes('orpheus')) {
      console.log('[NCM] Player already configured:', existingPlayer.trim());
      return;
    }
  } catch {
    // config get failed — no player set, detect and configure
  }
  try {
    // Find mpv in PATH or common install locations
    try {
      await execFileP(process.platform === 'win32' ? 'where.exe' : 'which', ['mpv'], { timeout: 5000, windowsHide: true });
      await runNcmCli(['config', 'set', 'player', 'mpv'], 8000);
      console.log('[NCM] Auto-configured player: mpv');
      return;
    } catch {
      // mpv is not in PATH; continue with common install locations.
    }
    // Check common Windows install path
    if (process.platform === 'win32') {
      if (fs.existsSync('C:\\Program Files\\MPV Player\\mpv.exe')) {
        // Add to PATH for current process
        process.env.PATH = (process.env.PATH || '') + ';C:\\Program Files\\MPV Player';
        await runNcmCli(['config', 'set', 'player', 'mpv'], 8000);
        console.log('[NCM] Auto-configured player: mpv (C:\\Program Files\\MPV Player)');
        return;
      }
    }
    console.log('[NCM] mpv not found — music playback unavailable. Install mpv from https://mpv.io');
  } catch (e: any) {
    console.warn('[NCM] Failed to auto-configure player:', e.message || String(e));
  }
})();

apiRouter.get('/ncm/login/status', async (_req, res) => {
  const done = await checkNcmLoginStatus(8000);
  res.json({ done, qrUrl: ncmLoginQrUrl });
});

// ── Org routes ──
// Org routes are always mounted — personal and org coexist at different URLs.
// / → personal desktop, /index.org.html → org workbench.
{
  const { mountOrgRoutes } = await import("./server/org/routes");
  mountOrgRoutes(apiRouter, io);
  const { mountBranchRoutes } = await import("./server/org/main_api");
  const { attachOrgWs } = await import("./server/org/ws_sync");
  mountBranchRoutes(apiRouter);
  attachOrgWs(io);
  console.log('[Org] Routes mounted at /api/org/*');
  console.log('[Org] Branch API mounted at /api/branch/*');
  console.log('[Org] WebSocket sync attached');
}

// ── Infrastructure ──
setupMessaging(apiRouter, llm);
setupMcpServer(app, server, io, llm, path.join(__dirname, 'server'));
initSocketRuntime({ io, jwtSecret: JWT_SECRET, llm });

// Cleanup mpv on exit so music stops when server shuts down
process.on('exit', () => {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/F', '/IM', 'mpv.exe'], { timeout: 3000, stdio: 'ignore' });
    }
  } catch {}
});
// SIGINT/SIGTERM are handled by bootstrap.ts with proper cleanup + flushDB

async function start() {
  await setupStatic(app, __filename, __dirname, ROLE);
  // Phase2 模块1：感知事件队列维护定时器（空闲回捞后备积压 + 过期清扫）
  startPerceptionQueueMaintenance();
  // Phase-3 初始化（initPhase3 依赖本地未提交模块 → 已注释停用，恢复时取消注释即可）：
  // try {
  //   await initPhase3();
  // } catch (err: any) {
  //   console.error('[Phase3] 初始化失败（不阻断主服务）:', err?.message || err);
  // }
  await bootstrap({ server, io, PORT, HOST, jwtSecret: JWT_SECRET, llm, __dirname });
}

// ===== Desire 驱力引擎（已停用 — 数字生命体系统接管） =====
// try {
//   const engine = getDesireEngine();
//   engine.tick();
//   setInterval(() => { engine.tick(); }, 600000);
//   console.log('[Desire] 引擎已启动，tick 间隔: 10分钟');
// } catch (err) {
//   console.error('[Desire] 引擎启动失败:', err);
// }
// ===== Desire 引擎启动结束 =====

// ===== 金融数据源管理器启动 =====
try {
  registerDataSources();
  console.log('[DataSource] 金融数据源管理器已启动');
} catch (err) {
  console.error('[DataSource] 数据源注册失败:', err);
}

// ===== 数字生命体系统启动 =====
try {
  const life = getLifeSystem();
  life.initializeLifeSystem().then((result) => {
    if (result.ok) console.log('[LifeSystem] ✅ 数字生命体初始化完成');
    else console.warn('[LifeSystem] ⚠️ 初始化有错误:', result.errors);
    life.start();
  }).catch((err) => {
    console.error('[LifeSystem] 初始化失败:', err.message);
  });
  console.log('[LifeSystem] 数字生命体系统已触发启动');
} catch (err) {
  console.error('[LifeSystem] 启动失败:', err);
}
// ===== 数字生命体启动结束 =====

// ===== Paradigm-Phase0 范式防护层启动 =====
try {
  logParadigmPhase0Status();
} catch (err) {
  console.error('[Paradigm-Phase0] 状态输出失败:', err);
}

// P1-4 说明：此处的 process.exit(1) 是启动失败 fail-fast（服务从未进入可用状态，
// 无任何会话/脏数据可救），由 docker restart 策略拉起重试 —— 与「全局猝死处理器」
// 无关，属有意保留的显式退出。bootstrap 内部 DB 初始化失败经 throw 汇入此处。
start().catch((err) => {
  console.error('[FATAL] Server startup failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
