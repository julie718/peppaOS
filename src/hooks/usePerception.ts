import { useCallback } from 'react';
import { useSocket } from './useSocket';

/**
 * Hook for pushing multimodal perception events to the server's fusion layer.
 * Components capture sensor data and push it here; the server fuses it into
 * the sensory context that Lumi sees in every system prompt.
 */
export function usePerception() {
  const socket = useSocket();

  const pushVisualScene = useCallback((description: string, objects?: string[], faces?: number) => {
    if (!socket?.connected) return;
    socket.emit('perception:visual_scene', { description, objects, faces });
  }, [socket]);

  const pushAudioEmotion = useCallback((emotion: string, intensity?: number) => {
    if (!socket?.connected) return;
    socket.emit('perception:audio_emotion', { emotion, intensity: intensity ?? 0.5 });
  }, [socket]);

  const pushSpatialUpdate = useCallback((roomType?: string, dimensions?: { x: number; y: number; z: number }) => {
    if (!socket?.connected) return;
    socket.emit('perception:spatial_update', { roomType, dimensions });
  }, [socket]);

  return { pushVisualScene, pushAudioEmotion, pushSpatialUpdate };
}
