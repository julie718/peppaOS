import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { useSocket } from './useSocket';

let _musicVisible = false;
const _listeners = new Set<() => void>();
function setMusicVisible(v: boolean) {
  _musicVisible = v;
  _listeners.forEach(fn => fn());
}
export function useMusicVisible() {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
    () => _musicVisible,
  );
}

export interface MusicScene {
  colors: { bg: string; primary: string; secondary: string; accent: string };
  scene: string;
  particles: string;
  lyricsStyle: string;
  intensity: number;
  reason: string;
  terrainColors?: string[];
  emotion?: { valence: number; arousal: number };
}

export interface MusicTrack {
  name: string;
  artists: string[];
  album?: string;
  coverUrl?: string;
  duration?: number;
}

export interface MusicLyricLine {
  time: number;
  text: string;
}

export interface MusicAtmosphere {
  track: MusicTrack;
  mood: string;
  weather?: string;
  lumiReason?: string;
  audioUrl?: string;
  lyrics?: MusicLyricLine[];
  scene?: MusicScene;
}

export interface MusicPlayerState {
  isPlaying: boolean;
  track: MusicTrack | null;
  progress: number;
  duration: number;
  volume: number;
  mood: string;
  weather?: string;
  lumiReason?: string;
  lyrics: MusicLyricLine[];
  scene: MusicScene | null;
  visible: boolean;
  source: 'netease' | 'minimax' | 'url' | null;
}

export function useMusicPlayer() {
  const socket = useSocket();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<MusicPlayerState>({
    isPlaying: false,
    track: null,
    progress: 0,
    duration: 0,
    volume: 70,
    mood: 'peaceful',
    weather: undefined,
    lumiReason: undefined,
    lyrics: [],
    scene: null,
    visible: false,
    source: null,
  });

  // Create audio element on mount
  useEffect(() => {
    const audio = new Audio();
    audio.volume = state.volume / 100;
    audioRef.current = audio;

    audio.addEventListener('timeupdate', () => {
      setState(prev => ({ ...prev, progress: audio.currentTime }));
    });
    audio.addEventListener('loadedmetadata', () => {
      setState(prev => ({ ...prev, duration: audio.duration }));
    });
    audio.addEventListener('ended', () => {
      setState(prev => ({ ...prev, isPlaying: false }));
      socket?.emit('music:next');
    });

    return () => { audio.pause(); audio.src = ''; };
  }, []);

  // Listen for backend events
  useEffect(() => {
    if (!socket) return;

    const onAtmosphere = (data: MusicAtmosphere) => {
      setMusicVisible(true);
      setState(prev => ({
        ...prev,
        track: data.track,
        mood: data.mood,
        weather: data.weather,
        lumiReason: data.lumiReason,
        lyrics: data.lyrics || [],
        scene: data.scene || null,
        visible: true,
        isPlaying: true,
        progress: 0,
        duration: data.track.duration ? data.track.duration / 1000 : prev.duration,
        source: data.audioUrl ? 'url' : 'netease',
      }));
      if (data.audioUrl && audioRef.current) {
        audioRef.current.src = data.audioUrl;
        audioRef.current.play().catch(() => {});
      }
    };

    // Local progress ticker for ncm-cli (mpv) playback — no audio element available
    const progressInterval = setInterval(() => {
      setState(prev => {
        if (prev.source !== 'netease' || !prev.isPlaying || !prev.duration) return prev;
        const next = prev.progress + 0.5;
        return next >= prev.duration ? { ...prev, progress: prev.duration, isPlaying: false } : { ...prev, progress: next };
      });
    }, 500);

    const onState = (data: any) => {
      setState(prev => ({
        ...prev,
        track: data.trackName ? {
          name: data.trackName,
          artists: data.artists || [],
          album: data.album,
          coverUrl: data.coverUrl,
          duration: data.duration,
        } : prev.track,
        isPlaying: data.playing ?? prev.isPlaying,
        progress: data.progress != null ? data.progress : prev.progress,
        duration: data.duration ? data.duration / 1000 : prev.duration,
        volume: data.volume ?? prev.volume,
        source: data.source ?? prev.source,
      }));
      if (data.audioUrl && audioRef.current) {
        audioRef.current.src = data.audioUrl;
        audioRef.current.play().catch(() => {});
      }
    };

    const onLyrics = (data: { lyrics: MusicLyricLine[] }) => {
      setState(prev => ({ ...prev, lyrics: data.lyrics || [] }));
    };

    const onError = (data: { message: string }) => {
      console.warn('[Music]', data.message);
    };

    socket.on('music:atmosphere', onAtmosphere);
    socket.on('music:state', onState);
    socket.on('music:lyrics', onLyrics);
    socket.on('music:error', onError);

    return () => {
      clearInterval(progressInterval);
      socket.off('music:atmosphere', onAtmosphere);
      socket.off('music:state', onState);
      socket.off('music:lyrics', onLyrics);
      socket.off('music:error', onError);
    };
  }, [socket]);

  const play = useCallback(() => {
    if (audioRef.current?.src) audioRef.current.play().catch(() => {});
    socket?.emit('music:resume');
    setState(prev => ({ ...prev, isPlaying: true }));
  }, [socket]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    socket?.emit('music:pause');
    setState(prev => ({ ...prev, isPlaying: false }));
  }, [socket]);

  const next = useCallback(() => {
    socket?.emit('music:next');
  }, [socket]);

  const prev = useCallback(() => {
    socket?.emit('music:prev');
  }, [socket]);

  const seek = useCallback((seconds: number) => {
    if (audioRef.current) audioRef.current.currentTime = seconds;
    socket?.emit('music:seek', { seconds });
    setState(prev => ({ ...prev, progress: seconds }));
  }, [socket]);

  const setVolume = useCallback((level: number) => {
    const vol = Math.max(0, Math.min(100, level));
    if (audioRef.current) audioRef.current.volume = vol / 100;
    socket?.emit('music:volume', { level: vol });
    setState(prev => ({ ...prev, volume: vol }));
  }, [socket]);

  const show = useCallback(() => {
    setMusicVisible(true);
    setState(prev => ({ ...prev, visible: true }));
  }, []);
  const hide = useCallback(() => {
    setMusicVisible(false);
    setState(prev => ({ ...prev, visible: false }));
  }, []);

  return {
    ...state,
    play, pause, next, prev, seek, setVolume, show, hide,
  };
}
