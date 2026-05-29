// LumiOS Unified Server
// LUMI_ROLE=personal (default) → personal AI OS
// LUMI_ROLE=enterprise         → enterprise server with org management
// A personal instance can upgrade: create org → restart with LUMI_ROLE=enterprise
import "dotenv/config";
import { fileURLToPath } from "url";
import path from "path";
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
import fileRoutes from "./routes/files";
import { subscriptionRoutes } from "./server/subscription/routes";
import { resolveRole } from "./server/runtime/role";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROLE = resolveRole();

const { app, server, io, apiRouter, PORT, HOST, JWT_SECRET, getCookieOptions } = createApp();
const llm = createLLMRuntime();

// ── Shared routes (both roles) ──
mountAllRoutes({ apiRouter, jwtSecret: JWT_SECRET, llm, getCookieOptions, io });
apiRouter.use("/", voiceRoutes);
apiRouter.use("/", fileRoutes);
apiRouter.use("/", subscriptionRoutes);
apiRouter.use("/", lapRoutes);

// ── Enterprise routes ──
// Org creation is always available (personal→enterprise upgrade path).
// Full enterprise routes mount only when ROLE=enterprise.
{
  const { mountEnterpriseRoutes } = await import("./server/enterprise/routes");
  mountEnterpriseRoutes(apiRouter, io); // POST /enterprise/org always works
  if (ROLE === 'enterprise') {
    const { mountBranchRoutes } = await import("./server/enterprise/main_api");
    const { attachEnterpriseWs } = await import("./server/enterprise/ws_sync");
    mountBranchRoutes(apiRouter);
    attachEnterpriseWs(io);
    console.log('[Enterprise] Routes mounted at /api/enterprise/*');
    console.log('[Enterprise] Branch API mounted at /api/branch/*');
    console.log('[Enterprise] WebSocket sync attached');
  }
}

// ── Infrastructure ──
setupMessaging(apiRouter, llm);
setupMcpServer(app, server, io, llm, path.join(__dirname, 'server'));
initSocketRuntime({ io, jwtSecret: JWT_SECRET, llm });

// Enterprise: redirect root to workbench; personal: root to web app
if (ROLE === 'enterprise') {
  app.get('/', (_req, res) => res.redirect('/index.enterprise.html'));
}

async function start() {
  await setupStatic(app, __filename, __dirname, ROLE);
  await bootstrap({ server, io, PORT, HOST, jwtSecret: JWT_SECRET, llm, __dirname });
}

start();
