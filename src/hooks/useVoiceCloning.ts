import { useState, useRef, useCallback } from 'react';
import { uploadSamples, cloneVoice as apiCloneVoice, listVoices } from '../services/voiceService';

interface VoiceCloneState {
  isRecording: boolean;
  audioLevel: number;
  recordings: Blob[];
  isUploading: boolean;
  isCloning: boolean;
  cloneProgress: string;
  voices: any[];
  error: string | null;
}

export function useVoiceCloning() {
  const [state, setState] = useState<VoiceCloneState>({
    isRecording: false,
    audioLevel: 0,
    recordings: [],
    isUploading: false,
    isCloning: false,
    cloneProgress: '',
    voices: [],
    error: null,
  });

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const animationFrame = useRef<number>(0);
  const chunks = useRef<Blob[]>([]);

  const updateAudioLevel = useCallback(() => {
    if (!analyser.current) return;
    const dataArray = new Uint8Array(analyser.current.frequencyBinCount);
    analyser.current.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    setState(prev => ({ ...prev, audioLevel: avg / 255 }));
    animationFrame.current = requestAnimationFrame(updateAudioLevel);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      chunks.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      audioContext.current = new AudioContext();
      const source = audioContext.current.createMediaStreamSource(stream);
      analyser.current = audioContext.current.createAnalyser();
      analyser.current.fftSize = 256;
      source.connect(analyser.current);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      mediaRecorder.current = new MediaRecorder(stream, { mimeType });

      mediaRecorder.current.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };

      mediaRecorder.current.onstop = () => {
        const blob = new Blob(chunks.current, { type: mimeType });
        setState(prev => ({
          ...prev,
          isRecording: false,
          recordings: [...prev.recordings, blob],
        }));
        stream.getTracks().forEach(t => t.stop());
        if (audioContext.current) audioContext.current.close();
        cancelAnimationFrame(animationFrame.current);
      };

      mediaRecorder.current.start();
      setState(prev => ({ ...prev, isRecording: true, audioLevel: 0 }));
      updateAudioLevel();
    } catch (err: any) {
      setState(prev => ({ ...prev, error: err.message || 'Microphone access denied' }));
    }
  }, [updateAudioLevel]);

  const stopRecording = useCallback(() => {
    if (mediaRecorder.current && mediaRecorder.current.state !== 'inactive') {
      mediaRecorder.current.stop();
    }
  }, []);

  const removeRecording = useCallback((index: number) => {
    setState(prev => ({
      ...prev,
      recordings: prev.recordings.filter((_, i) => i !== index),
    }));
  }, []);

  const addFiles = useCallback((files: File[]) => {
    setState(prev => ({
      ...prev,
      recordings: [...prev.recordings, ...files],
    }));
  }, []);

  const uploadAndClone = useCallback(async (name: string) => {
    if (state.recordings.length === 0) {
      setState(prev => ({ ...prev, error: 'No recordings to clone from' }));
      return null;
    }

    try {
      setState(prev => ({ ...prev, isUploading: true, cloneProgress: 'Uploading samples...' }));

      const files = state.recordings.map((blob, i) =>
        new File([blob], `sample_${i}.webm`, { type: blob.type })
      );

      const { urls } = await uploadSamples(files);

      setState(prev => ({ ...prev, isUploading: false, isCloning: true, cloneProgress: 'Cloning voice...' }));

      const result = await apiCloneVoice(urls, name);

      setState(prev => ({
        ...prev,
        isCloning: false,
        cloneProgress: 'Clone complete!',
        voices: [...prev.voices, result],
        recordings: [],
      }));

      return result;
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        isUploading: false,
        isCloning: false,
        error: err.message,
      }));
      return null;
    }
  }, [state.recordings]);

  const refreshVoices = useCallback(async () => {
    try {
      const data = await listVoices();
      setState(prev => ({ ...prev, voices: [...data.cloned, ...data.premade] }));
    } catch {
      // voices unavailable
    }
  }, []);

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    startRecording,
    stopRecording,
    removeRecording,
    addFiles,
    uploadAndClone,
    refreshVoices,
    clearError,
  };
}
