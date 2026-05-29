import { Socket } from "socket.io";
import { createWakeDetector, isWakeWord } from "../stt/wake_detector";
import { isEchoText, isTtsPlaying } from "./voice";
import { logger } from "../../logger";

export function registerWakeHandlers(socket: Socket, getUserId: (s: Socket) => string) {
  let wakeDetector: ReturnType<typeof createWakeDetector> | null = null;

  socket.on("wake:start", async () => {
    const uid = getUserId(socket);
    try {
      if (wakeDetector) { try { wakeDetector.stop(); } catch {} }
      wakeDetector = createWakeDetector(undefined, isEchoText);

      wakeDetector.onWake((keyword: string) => {
        logger.info(`[Wake] "${keyword}" detected for user ${uid}`);
        socket.emit("wake:detected", { keyword, timestamp: new Date().toISOString() });
      });

      wakeDetector.onError((err: Error) => {
        logger.error(`[Wake] Error for user ${uid}:`, err.message);
        socket.emit("wake:error", { message: err.message });
      });

      socket.emit("wake:started");
      logger.info(`[Wake] Started for user ${uid}`);
    } catch (err: any) {
      socket.emit("wake:error", { message: err.message || 'Failed to start wake detector' });
    }
  });

  socket.on("wake:audio", (data: { audio: number[] }) => {
    if (!wakeDetector) return;
    if (isTtsPlaying()) return;
    try {
      const buf = Buffer.from(new Int16Array(data.audio).buffer);
      wakeDetector.sendAudio(buf);
    } catch {}
  });

  socket.on("wake:stop", () => {
    if (wakeDetector) {
      try { wakeDetector.stop(); } catch {}
      wakeDetector = null;
    }
  });
}
