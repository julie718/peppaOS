import path from "path";
import { logger } from '../lib/logger';
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { readDB, writeDB, flushDB, ensureDatabaseInitialized, isDbDirty, pruneOldData } from "../../db_layer";
import { toolRegistry } from "../tools/registry";
import { registerAllTools } from "../tools/definitions/index";
import { mcpManager, registerMCPTools } from "../mcp";
import { scheduler, registerScheduledTasks } from "../scheduler";
import { runFirstBootExploration, isFirstBootComplete } from "../autonomy/system_explorer";
import { installProfessionAgents } from "../autonomy/profession_templates";
import bcrypt from "bcryptjs";

interface BootstrapContext {
  server: any;
  io: any;
  PORT: number;
  HOST: string;
  jwtSecret: string;
  llm: {
    getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
    getOllama?: any; getLmStudio?: any; getArk?: any; getXiaomi?: any; getKimi?: any; getGlm?: any; getRelay?: any;
  };
  __dirname: string;
}

function scheduleFirstBootExploration(delayMs = 30000) {
  const timer = setTimeout(() => {
    try {
      if (!isFirstBootComplete()) {
        logger.info('[Bootstrap] First boot detected - running system exploration after server startup...');
        const snapshot = runFirstBootExploration();
        logger.info(`[Bootstrap] Exploration complete: ${snapshot.hardware.cpus.model}, ${snapshot.hardware.totalMemoryGB}GB RAM, ${snapshot.software.installedApps.length} apps, ${snapshot.filesystem.totalUserFiles} user files`);
        const installed = installProfessionAgents();
        if (installed > 0) logger.info(`[Bootstrap] Installed ${installed} profession agents`);
      }
    } catch (err) {
      logger.warn('[Bootstrap] System exploration failed:', (err as Error).message);
    }
  }, delayMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

function schedulePostStartupFlush(delayMs: number) {
  const timer = setTimeout(() => {
    if (!isDbDirty()) return;
    flushDB()
      .then(() => logger.info(`[Bootstrap] Database flushed after startup writes (${delayMs}ms)`))
      .catch((err: any) => logger.warn('[Bootstrap] Post-startup database flush failed:', err?.message || err));
  }, delayMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

export async function bootstrap(ctx: BootstrapContext) {
  const { server, io, PORT, HOST, jwtSecret, llm, __dirname } = ctx;

  // P1-4：启动期配置/DB 初始化失败改为 throw → 汇入 server.ts start().catch
  // 的 fail-fast 退出（服务从未启动，无会话可救），不再在 bootstrap 内直接
  // process.exit(1)（全局猝死逻辑已废除，此处显式 throw 不会被错误吞掉）。
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is not set.');
  }

  try {
    await ensureDatabaseInitialized();
    logger.info('Database initialized successfully');
    pruneOldData();
    await flushDB();
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    throw error;
  }

  // Peppa account is created via /api/auth/register or db migration.
  // Server no longer auto-creates it — prevents random UID on every restart.

  // Register all agent tools
  registerAllTools(toolRegistry, { getDeepSeek: llm.getDeepSeek, getGemini: llm.getGemini, getOpenAI: llm.getOpenAI, getAnthropic: llm.getAnthropic, getQwen: llm.getQwen });
  logger.info(`[Tools] Registered ${toolRegistry.list().length} built-in tools`);

  // Register MCP tools (non-blocking)
  registerMCPTools(io).then(mcpTools => {
    if (mcpTools.length > 0) {
      logger.info(`[MCP] Registered ${mcpTools.length} MCP tools (total: ${toolRegistry.list().length})`);
    }
  }).catch(err => {
    logger.warn('[MCP] Tool registration warning:', err.message);
  });

  // Start GPT-SoVITS API server (optional)
  let gptSovitsProcess: ChildProcess | null = null;
  const gptSovitsDir = path.join(__dirname, 'gpt-sovits-src');
  const pythonExe = path.join(gptSovitsDir, 'venv/Scripts/python.exe');
  const apiPy = path.join(gptSovitsDir, 'api_v2.py');
  if (fs.existsSync(pythonExe) && fs.existsSync(apiPy)) {
    logger.info('[GPT-SoVITS] Starting API server...');
    gptSovitsProcess = spawn(pythonExe, [
      apiPy,
      '-a', '127.0.0.1',
      '-p', '9880',
      '-c', 'GPT_SoVITS/configs/tts_infer.yaml',
    ], {
      cwd: gptSovitsDir,
      stdio: 'pipe',
    });
    gptSovitsProcess.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) logger.info(`[GPT-SoVITS] ${line}`);
    });
    gptSovitsProcess.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) logger.warn(`[GPT-SoVITS] ${line}`);
    });
    gptSovitsProcess.on('error', (err) => {
      logger.warn('[GPT-SoVITS] Process error:', err.message);
      gptSovitsProcess = null;
    });
    gptSovitsProcess.on('exit', (code) => {
      if (code && code !== 0) logger.warn(`[GPT-SoVITS] Exited with code ${code}`);
      gptSovitsProcess = null;
    });
  } else {
    logger.info('[GPT-SoVITS] Not found — TTS will use cloud providers only.');
  }

  // P1-4 说明：EADDRINUSE 属致命启动失败（服务从未成功绑定端口，无会话可救），
  // 保留显式 fail-fast 退出，由 docker restart 策略拉起重试；非「全局猝死逻辑」。
  // 其余 listen 期错误仅记录并尽力落盘，不再直接杀进程。
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`[FATAL] Port ${PORT} is already in use. Please close the other process and try again.`);
      process.exit(1);
    } else {
      logger.error('[FATAL] Server error（保持存活）:', err.message);
      try {
        flushDB().catch(() => {});
      } catch {}
    }
  });

  server.listen(PORT, HOST, () => {
    logger.info(`Server running on http://${HOST}:${PORT}`);
    scheduler.setIO(io);
    registerScheduledTasks(llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen, llm.getOllama, llm.getLmStudio, llm.getArk, llm.getXiaomi, llm.getKimi, llm.getGlm, llm.getRelay);

    // Clean up stale ephemeral agents on startup
    try {
      const db = readDB();
      if (db.agents) {
        const before = db.agents.length;
        db.agents = db.agents.filter((a: any) => !a.id.startsWith('ephemeral_'));
        if (before !== db.agents.length) {
          writeDB(db);
          logger.info(`[Bootstrap] Cleaned ${before - db.agents.length} ephemeral agents`);
        }
      }
    } catch {}

    // Auto-install legal and design agent templates to all orgs
    import('../legal/templates').then(({ installLegalTemplates }) => {
      const db2 = readDB();
      const orgs = (db2 as any).organizations || [];
      let total = 0;
      for (const org of orgs) {
        total += installLegalTemplates(org.id);
      }
      if (total > 0) logger.info(`[Org] Installed ${total} legal agent templates across ${orgs.length} org(s)`);
    }).catch((err: any) => {
      logger.warn('[Org] Failed to install legal templates:', err.message);
    });

    import('../design/templates').then(({ installDesignTemplates }) => {
      const db2 = readDB();
      const orgs = (db2 as any).organizations || [];
      let total = 0;
      for (const org of orgs) {
        total += installDesignTemplates(org.id);
      }
      if (total > 0) logger.info(`[Org] Installed ${total} design agent templates across ${orgs.length} org(s)`);
    }).catch((err: any) => {
      logger.warn('[Org] Failed to install design templates:', err.message);
    });

    scheduleFirstBootExploration();
    schedulePostStartupFlush(5_000);
    schedulePostStartupFlush(30_000);
  });

  // Cleanup on exit
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    logger.info('[Shutdown] Cleaning up...');
    scheduler.stop();
    try {
      await flushDB();
      logger.info('[Shutdown] Database flushed');
    } catch {}
    try {
      await mcpManager.disconnectAll();
      logger.info('[MCP] All servers disconnected');
    } catch (err: any) {
      logger.warn('[MCP] Disconnect error:', err.message);
    }
    if (gptSovitsProcess && !gptSovitsProcess.killed) {
      logger.info('[GPT-SoVITS] Stopping API server...');
      gptSovitsProcess.kill();
    }
  };
  process.on('SIGINT', () => { cleanup().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { cleanup().then(() => process.exit(0)); });
}