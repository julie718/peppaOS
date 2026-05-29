import { Socket, Server } from "socket.io";
import { readDB } from "../../db_layer";
import { pushActivityEvent, setIdleState, getIdleState, getLastEvent } from "../context/activity_stream";
import { detectClipboardChange } from "../context/clipboard_monitor";
import { processActivityEvent } from "../context/proactive_triggers";

const ambientNoise = new Map<string, { rms: number; lastUpdate: string }>();

export function getAmbientNoise(userId: string): number | null {
  const info = ambientNoise.get(userId);
  if (!info) return null;
  if (Date.now() - new Date(info.lastUpdate).getTime() > 15000) return null;
  return info.rms;
}

export function registerAmbientHandlers(socket: Socket, getUserId: (s: Socket) => string, io: Server) {
  async function triggerIdleProcessing(userId: string, ioInstance: any) {
    try {
      const db = readDB();
      const activeConv = (db.conversations || []).find(
        (c: any) => c.userId === userId && c.status === 'active'
      );
      if (activeConv && activeConv.messageCount >= 10 && !activeConv.summary) {
        const { checkAutoSummary } = await import('../conversation/manager');
        checkAutoSummary(activeConv.id);
        console.log(`[IdleProcessing] Triggered auto-summary for conversation ${activeConv.id}`);
      }
    } catch (err: any) {
      console.warn(`[IdleProcessing] Summarize failed: ${err.message}`);
    }

    try {
      const { cleanupEphemeralAgents } = await import('../agents/orchestrator');
      const cleaned = cleanupEphemeralAgents(6);
      if (cleaned > 0) console.log(`[IdleProcessing] Cleaned up ${cleaned} ephemeral agents`);
    } catch {}
  }

  socket.on("ambient:window_update", (data: { title: string; process_name: string; pid: number }) => {
    const uid = getUserId(socket);
    if (!uid) return;
    const prev = getLastEvent(uid, 'window_changed');
    const prevTitle = prev?.data?.title || '';
    const prevProc = prev?.data?.process_name || '';
    const changed = data.title !== prevTitle || data.process_name !== prevProc;
    const event = { type: 'window_changed' as const, timestamp: new Date().toISOString(), data };
    pushActivityEvent(uid, event);
    if (changed) {
      processActivityEvent(event, uid, io);
    }
  });

  socket.on("ambient:idle_report", (data: { idle_ms: number; idle_seconds: number }) => {
    const uid = getUserId(socket);
    if (!uid) return;
    const isIdle = data.idle_seconds > 60;
    const wasIdle = getIdleState(uid).isIdle;
    setIdleState(uid, isIdle);
    socket.emit("ambient:idle_echo", data);
    if (isIdle && !wasIdle) {
      triggerIdleProcessing(uid, io).catch(err =>
        console.warn(`[IdleProcessing] Background task failed for ${uid}:`, err.message)
      );
    }
  });

  socket.on("ambient:noise_level", (data: { rms: number; isSpeaking: boolean; callState: string; timestamp: string }) => {
    const uid = getUserId(socket);
    if (!uid) return;
    ambientNoise.set(uid, { rms: data.rms, lastUpdate: data.timestamp });
  });

  socket.on("ambient:clipboard_report", (data: { text: string }) => {
    const uid = getUserId(socket);
    if (!uid) return;
    const result = detectClipboardChange(uid, data.text || '');
    if (result.changed) {
      const event = getLastEvent(uid, 'clipboard_changed');
      if (event) {
        processActivityEvent(event, uid, io);
      }
    }
  });
}
