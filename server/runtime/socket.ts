// Socket aggregator — mounts all Socket.IO handlers
import { Server } from "socket.io";
import { logger } from '../lib/logger';
import { notifySocketConnect, notifySocketDisconnect } from '../core/mainLoop';
import jwt from "jsonwebtoken";
import { registerChatHandler } from "../socket/chat";
import { registerTaskHandler } from "../socket/task";
import { registerVoiceHandlers } from "../socket/voice";
import { registerDeviceHandlers } from "../socket/device";
import { registerPerceptionHandlers } from "../socket/perception";
import { registerAmbientHandlers } from "../socket/ambient";
import { registerConversationHandlers } from "../socket/conversations";
import { registerWakeHandlers } from "../socket/wake";
import { registerTerminalHandlers } from "../socket/terminal";
import { registerMusicHandlers } from "../socket/music";
import { registerClientSelfHandlers } from "../socket/client_self";
import { getSensory } from "../socket/shared";
import { perceptionEvents } from "../socket/shared";
import { deviceRegistry } from "../devices";
import { personalityRegistry } from "../personality";
import { setOnAgentPromoted } from "../agents/orchestrator";
import { initMemorySync, initMemoryAssociations } from "../memory";
import { handleAutonomousDesktopResult } from "../autonomy/task_executor";
import { getDesireEngine } from '../desire/engine.js';
import { triggerHeartbeatIfReady } from '../heartbeat/injector.js';

interface SocketContext {
  io: Server;
  jwtSecret: string;
  llm: {
    getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any; getArk: any; getOllama: any; isOllamaAvailable: any; getLmStudio: any; isLmStudioAvailable: any; getXiaomi: any; getKimi: any; getGlm: any; getRelay: any;
  };
}

function getUserIdFromSocket(socket: any, jwtSecret: string): string {
  try {
    const authToken = socket.handshake?.auth?.token;
    if (authToken) {
      const decoded: any = jwt.verify(authToken, jwtSecret);
      return decoded.uid || 'anonymous';
    }
    const cookies = socket.handshake.headers.cookie;
    if (cookies) {
      const token = cookies.split(';').find((c: string) => c.trim().startsWith('token='))?.split('=')[1];
      if (token) {
        const decoded: any = jwt.verify(token, jwtSecret);
        return decoded.uid || 'anonymous';
      }
    }
  } catch {}
  return 'anonymous';
}

export function initSocketRuntime({ io, jwtSecret, llm }: SocketContext) {
  // Personality loading
  personalityRegistry.load();

  // Set up broadcast callbacks
  deviceRegistry.setBroadcast((event, data) => { io.emit(event, data); });
  personalityRegistry.setBroadcast((event, data) => { io.emit(event, data); });

  // Wire up agent promotion notifications
  setOnAgentPromoted((agent) => {
    io.emit('agent:promoted', {
      id: agent.id, name: agent.name,
      skillTags: agent.skillTags, autoCreated: true,
    });
  });

  // Initialize memory sync
  initMemorySync(io);
  initMemoryAssociations();

  const llmGetters = {
    getDeepSeek: llm.getDeepSeek,
    getGemini: llm.getGemini,
    getOpenAI: llm.getOpenAI,
    getAnthropic: llm.getAnthropic,
    getQwen: llm.getQwen,
    getArk: llm.getArk,
    getOllama: llm.getOllama,
    isOllamaAvailable: llm.isOllamaAvailable,
    getLmStudio: llm.getLmStudio,
    isLmStudioAvailable: llm.isLmStudioAvailable,
    getXiaomi: llm.getXiaomi,
    getKimi: llm.getKimi,
    getGlm: llm.getGlm,
    getRelay: llm.getRelay,
  };

  io.on("connection", (socket) => {
    notifySocketConnect();
    const uid = getUserIdFromSocket(socket, jwtSecret);
    // Join user room so all this user's sockets (DesktopUI, AgentChatPage, etc.) share events
    socket.join(`user:${uid}`);
    logger.info(`[Socket] Client connected: ${socket.id} (uid=${uid})`);

    // ── 全局 WebSocket 连接追踪 ──
    (global as any).__activeSessionId = socket.handshake.query.sessionId || 'default';
    (global as any).__wsClients = (global as any).__wsClients || [];
    (global as any).__wsClients.push({ sessionId: (global as any).__activeSessionId, ws: socket });

    const getUserId = (s: any) => getUserIdFromSocket(s, jwtSecret);

    // DEBUG: log all incoming events
    socket.onAny((event, ...args) => {
      if (event.startsWith('tool:desktop_result:')) {
        const correlationId = event.slice('tool:desktop_result:'.length);
        handleAutonomousDesktopResult(correlationId, args[0] || {});
      }
      const noisyEvents = new Set([
        'audio:chunk',
        'wake:audio',
        'ambient:idle_report',
        'ambient:noise_level',
        'ambient:window_update',
        'ambient:clipboard_report',
        'client:state',
        'presence:heartbeat',
      ]);
      if (event !== 'device:register' && !noisyEvents.has(event)) {
        logger.info(`[Socket:${socket.id}] event: ${event} args:`, JSON.stringify(args).slice(0, 200));
      }
    });

    // Ping/pong
    socket.on("ping", () => { socket.emit("pong"); });

    // Clean up perception events on disconnect
    socket.on("disconnect", () => {
      notifySocketDisconnect();
      const uid = getUserId(socket);
      perceptionEvents.delete(uid);
      (global as any).__wsClients = (global as any).__wsClients.filter(
        (c: any) => c.ws !== socket
      );
    });

    // Skill event relay — forward client-emitted skill events to all connected clients
    socket.on("skill:installed", (data) => { socket.broadcast.emit("skill:installed", data); });
    socket.on("skill:uninstalled", (data) => { socket.broadcast.emit("skill:uninstalled", data); });
    socket.on("skill:updated", (data) => { socket.broadcast.emit("skill:updated", data); });

    socket.on("bio:update", (payload) => {
      try {
        const { heartRate, hrv, steps } = payload;
        const engine = getDesireEngine();

        if (heartRate !== null && typeof heartRate === 'number') {
          if (heartRate > 100) {
            engine.ingest({ fatigue: 0.05, stress: 0.03 });
          } else if (heartRate < 60) {
            engine.ingest({ stress: -0.02 });
          }
        }

        if (hrv !== null && typeof hrv === 'number' && hrv < 30) {
          engine.ingest({ stress: 0.08, attachment: 0.05 });
        }

        if (steps !== null && typeof steps === 'number' && steps > 5000) {
          engine.ingest({ fatigue: 0.02, curiosity: 0.03 });
        }

        engine.tick();
        triggerHeartbeatIfReady();

        const intent = engine.getTopIntent();
        if (intent.score >= 0.55) {
          console.log(`[Heartbeat] 触发心跳: ${intent.message} (${intent.score.toFixed(2)})`);
        }

        socket.emit('bio:ack', { status: 'ok', intent });
      } catch (err) {
        console.error('[bio:update] 处理失败:', err);
      }
    });

    // Register all handlers
    registerDeviceHandlers(socket, getUserId, io);
    registerPerceptionHandlers(socket, getUserId, io);
    registerAmbientHandlers(socket, getUserId, io);
    registerConversationHandlers(socket, getUserId);
    registerWakeHandlers(socket, getUserId);
    registerTerminalHandlers(socket, getUserId);
    registerMusicHandlers(socket, getUserId, io);
    registerClientSelfHandlers(socket, getUserId, io);
    registerChatHandler(socket, llmGetters, (uid: string) => getSensory(uid), getUserId);
    registerTaskHandler(socket, llmGetters, (uid: string) => getSensory(uid), getUserId);
    registerVoiceHandlers(socket, llmGetters, (uid: string) => getSensory(uid), getUserId);
  });
}
