// Canvas input bar — fixed bottom input for sending tasks
import React, { useState, useRef, useCallback } from 'react';
import { Loader2, Mic, Paperclip, Send, Square } from 'lucide-react';
import { toast } from 'sonner';

interface CanvasInputBarProps {
  onSend: (text: string) => void;
  onImportFiles?: (files: FileList) => void;
  disabled?: boolean;
  t: any;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Failed to read audio'));
    reader.readAsDataURL(blob);
  });
}

export function CanvasInputBar({ onSend, onImportFiles, disabled, t }: CanvasInputBarProps) {
  const [text, setText] = useState('');
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const resizeInput = useCallback(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
      el.focus();
    });
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  }, [text, disabled, onSend]);

  const appendTranscript = useCallback((transcript: string) => {
    const next = transcript.trim();
    if (!next) return;
    setText(prev => prev.trim() ? `${prev.trim()} ${next}` : next);
    resizeInput();
  }, [resizeInput]);

  const cleanupRecording = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const transcribeBlob = useCallback(async (blob: Blob) => {
    setVoiceState('transcribing');
    try {
      const audio = await blobToBase64(blob);
      const res = await fetch('/api/audio/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ audio, fileName: 'canvas-input.webm' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t.speechRecognitionFailed || 'Speech recognition failed');
      if (data.text) appendTranscript(data.text);
      else toast.error(data.note || data.error || t.speechRecognitionFailed || 'Speech recognition failed');
    } catch (err: any) {
      toast.error(err.message || t.speechRecognitionFailed || 'Speech recognition failed');
    } finally {
      setVoiceState('idle');
      cleanupRecording();
    }
  }, [appendTranscript, cleanupRecording, t]);

  const handleVoiceInput = useCallback(async () => {
    if (disabled || voiceState === 'transcribing') return;
    if (voiceState === 'recording') {
      recorderRef.current?.stop();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error(t.speechRecognitionUnsupported || 'Speech recognition is not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        toast.error(t.speechRecognitionFailed || 'Speech recognition failed');
        setVoiceState('idle');
        cleanupRecording();
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size < 800) {
          setVoiceState('idle');
          cleanupRecording();
          return;
        }
        void transcribeBlob(blob);
      };
      recorder.start();
      setVoiceState('recording');
    } catch (err: any) {
      setVoiceState('idle');
      cleanupRecording();
      const message = err?.name === 'NotAllowedError'
        ? (t.microphonePermissionDenied || 'Microphone permission denied')
        : (err.message || t.speechRecognitionFailed || 'Speech recognition failed');
      toast.error(message);
    }
  }, [cleanupRecording, disabled, t, transcribeBlob, voiceState]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  return (
    <div className="absolute bottom-0 left-0 right-0 z-30 p-4">
      <div className="max-w-3xl mx-auto">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept=".txt,.md,.json,.csv,.pdf,.docx,.xlsx,.xls,.ts,.tsx,.js,.jsx,.py,.html,.css,.yaml,.yml,.xml,.log,.png,.jpg,.jpeg,.webp"
          onChange={(event) => {
            if (event.target.files?.length) onImportFiles?.(event.target.files);
            event.currentTarget.value = '';
          }}
        />
        <div className="lumi-surface flex items-end gap-2 rounded-2xl px-4 py-3">
          <textarea
            ref={inputRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={t.canvasTaskPlaceholder || 'Describe your task...'}
            disabled={disabled}
            rows={1}
            className="max-h-[120px] flex-1 resize-none bg-transparent py-0.5 text-sm text-white/90 outline-none placeholder:text-white/30"
          />
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || !onImportFiles}
              className="lumi-icon-button border-transparent bg-transparent"
              title={t.canvasImportFiles || 'Import files'}
            >
              <Paperclip size={17} />
            </button>
            <button
              onClick={handleVoiceInput}
              disabled={disabled || voiceState === 'transcribing'}
              className={`lumi-icon-button border-transparent ${
                voiceState === 'recording'
                  ? 'bg-teal-500/15 text-teal-300'
                  : 'bg-transparent'
              }`}
              title={voiceState === 'recording' ? (t.stopVoiceInput || 'Stop voice input') : (t.voiceInput || 'Voice input')}
            >
              {voiceState === 'transcribing' ? <Loader2 size={17} className="animate-spin" /> : voiceState === 'recording' ? <Square size={15} /> : <Mic size={17} />}
            </button>
            <button
              onClick={handleSend}
              disabled={!text.trim() || disabled}
              className="lumi-button-primary h-9 w-9 border-teal-400/30 bg-teal-500/20 p-0 text-teal-300 hover:bg-teal-500/30"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
