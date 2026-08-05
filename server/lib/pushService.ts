import { Server } from 'socket.io';

let ioInstance: Server | null = null;

export function setIO(io: Server): void {
  ioInstance = io;
  console.log('[PushService] IO instance registered');
}

export function getIO(): Server | null {
  return ioInstance;
}

export function emitProactivePush(payload: {
  scene: string;
  content: string;
  reason?: string;
  timestamp?: string;
}): boolean {
  if (!ioInstance) {
    console.warn('[PushService] IO not ready, cannot emit proactive push');
    return false;
  }

  ioInstance.emit('proactive:trigger', {
    ...payload,
    timestamp: payload.timestamp || new Date().toISOString(),
  });

  console.log(`[PushService] ✅ Proactive push sent: ${payload.scene}`);
  return true;
}
