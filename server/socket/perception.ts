import { Socket, Server } from "socket.io";
import { perceptionEvents, MAX_PERCEPTION_EVENTS } from "./shared";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState } from "../personality/state";

export function registerPerceptionHandlers(socket: Socket, getUserId: (s: Socket) => string, _io: Server) {
  socket.on("perception:visual_scene", (data: { description: string; objects?: string[]; faces?: number }) => {
    const uid = getUserId(socket);
    const events = perceptionEvents.get(uid) || [];
    events.push({
      modality: 'visual',
      deviceId: socket.id,
      timestamp: new Date().toISOString(),
      data,
    });
    if (events.length > MAX_PERCEPTION_EVENTS) events.shift();
    perceptionEvents.set(uid, events);
  });

  socket.on("perception:audio_emotion", (data: { emotion: string; intensity?: number }) => {
    const uid = getUserId(socket);
    const events = perceptionEvents.get(uid) || [];
    events.push({
      modality: 'audio',
      deviceId: socket.id,
      timestamp: new Date().toISOString(),
      data,
    });
    if (events.length > MAX_PERCEPTION_EVENTS) events.shift();
    perceptionEvents.set(uid, events);

    if (uid !== 'anonymous') {
      const emotionImpact: Record<string, number> = {
        happy: 0.5, excited: 0.4, calm: 0.1,
        sad: -0.3, angry: -0.5, frustrated: -0.4,
        neutral: 0,
      };
      const intensity = (emotionImpact[data.emotion] || 0) * (data.intensity || 0.5);
      if (Math.abs(intensity) > 0.05) {
        const state = loadEmotionalState(uid);
        const eventType = intensity > 0 ? 'positive_feedback' : 'negative_feedback';
        const updated = updateEmotionalState(state, {
          type: eventType,
          intensity: Math.abs(intensity),
          userId: uid,
          timestamp: new Date().toISOString(),
        });
        saveEmotionalState(uid, updated);
      }
    }
  });

  socket.on("perception:spatial_update", (data: { roomType?: string; dimensions?: { x: number; y: number; z: number } }) => {
    const uid = getUserId(socket);
    const events = perceptionEvents.get(uid) || [];
    events.push({
      modality: 'spatial',
      deviceId: socket.id,
      timestamp: new Date().toISOString(),
      data,
    });
    if (events.length > MAX_PERCEPTION_EVENTS) events.shift();
    perceptionEvents.set(uid, events);
  });
}
