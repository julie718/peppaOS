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

  if (!jwtSecret) {
    logger.error('FATAL: JWT_SECRET environment variable is not set.');
    process.exit(1);
  }

  try {
    await ensureDatabaseInitialized();
    logger.info('Database initialized successfully');
    pruneOldData();
    await flushDB();
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    process.exit(1);
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

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`[FATAL] Port ${PORT} is already in use. Please close the other process and try again.`);
    } else {
      logger.error('[FATAL] Server error:', err.message);
    }
    process.exit(1);
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