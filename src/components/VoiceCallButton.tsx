import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, Phone, Radio, Camera, Loader2, Volume2 } from 'lucide-react';
import { CallState } from '../hooks/useVoiceCall';
import { useT } from '../lib/useT';

interface VoiceCallButtonProps {
  callState: CallState;
  audioLevel: number;
  onStart: () => void;
  onEnd: () => void;
  hasVoice?: boolean;
  className?: string;
}

type Mode = 'idle' | 'call' | 'ptt';

const MENU_ITEMS = [
  { id: 'call',   icon: Phone,  label: '实时通话' },
  { id: 'ptt',    icon: Radio,  label: '对讲'     },
  { id: 'camera', icon: Camera, label: '拍照识别'  },
];

export function VoiceCallButton({ callState, audioLevel, onStart, onEnd, hasVoice = false, className = '' }: VoiceCallButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('idle');
  const pttHolding = useRef(false);
  const isActive = callState !== 'idle' && callState !== 'passive';
  const isOn = callState !== 'idle';
  const t = useT();

  const stateConfig: Record<CallState, { icon: React.ReactNode; color: string; label: string }> = {
    idle: { icon: <Mic size={20} />, color: 'bg-white/5 text-white/40 border-white/10', label: t.callStart || 'Start' },
    connecting: { icon: <Loader2 size={20} className="animate-spin" />, color: 'bg-celestial-saturn/10 text-celestial-saturn border-celestial-saturn/30', label: t.callConnecting || 'Connecting...' },
    listening: { icon: <Mic size={20} />, color: mode === 'ptt' ? 'bg-amber-500 text-black border-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.4)]' : 'bg-celestial-saturn text-black border-celestial-saturn shadow-[0_0_20px_rgba(255,204,0,0.4)]', label: t.callListening || 'Listening' },
    thinking: { icon: <Loader2 size={20} className="animate-spin" />, color: mode === 'ptt' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : 'bg-celestial-mars/10 text-celestial-mars border-celestial-mars/30', label: t.callThinking || 'Thinking' },
    speaking: { icon: <Volume2 size={20} />, color: mode === 'ptt' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : 'bg-celestial-glow/10 text-celestial-glow border-celestial-glow/30', label: t.callSpeaking || 'Speaking' },
    queued: { icon: <Loader2 size={20} className="animate-spin" />, color: 'bg-purple-500/10 text-purple-400 border-purple-500/30', label: t.callQueued || 'Queued' },
    passive: { icon: <motion.div animate={{ opacity: [0.15, 0.35, 0.15] }} transition={{ duration: 3, repeat: Infinity }}><Mic size={20} /></motion.div>, color: 'bg-white/5 text-white/45 border-white/5', label: t.callPassive || 'Passive' },
  };

  const config = stateConfig[callState];

  const resetMode = () => setMode('idle');
  const icon = mode === 'ptt' ? <Radio size={20} /> : mode === 'call' ? <Phone size={20} /> : config.icon;

  const handleClick = () => {
    if (isOn) { onEnd(); resetMode(); return; }
    setMenuOpen(true);
  };

  const handleMenuItem = (id: string) => {
    setMenuOpen(false);
    if (id === 'call') {
      setMode('call');
      onStart();
    } else if (id === 'ptt') {
      setMode('ptt');
      // PTT: user needs to press and hold to start recording
    } else if (id === 'camera') {
      openCamera();
    }
  };

  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.play();
      video.onloadeddata = () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d')!.drawImage(video, 0, 0);
        const base64 = canvas.toDataURL('image/jpeg', 0.8);
        stream.getTracks().forEach(t => t.stop());
        // Dispatch custom event so AgentChatPage can handle the image
        window.dispatchEvent(new CustomEvent('peppa:camera-capture', { detail: { imageBase64: base64 } }));
      };
    } catch {
      // Camera denied or unavailable
    }
  };

  // PTT: press to start, release to stop
  const handlePTTStart = () => {
    if (mode !== 'ptt' || isOn) return;
    pttHolding.current = true;
    onStart();
  };

  const handlePTTEnd = () => {
    if (mode !== 'ptt' || !pttHolding.current) return;
    pttHolding.current = false;
    if (isOn) onEnd();
  };

  const btnColor = mode === 'ptt' && !isOn
    ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
    : mode === 'ptt' && isActive
    ? config.color
    : config.color;

  return (
    <div className={`relative ${className}`}>
      <AnimatePresence>
        {isActive && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1 + audioLevel * 0.3, opacity: 0.15 + audioLevel * 0.2 }}
            exit={{ scale: 0.8, opacity: 0 }}
            className={`absolute inset-0 rounded-full ${
              mode === 'ptt' ? 'bg-amber-500' :
              callState === 'speaking' ? 'bg-celestial-glow' :
              callState === 'listening' ? 'bg-celestial-saturn' : 'bg-celestial-mars'
            }`}
          />
        )}
      </AnimatePresence>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={handleClick}
        onMouseDown={mode === 'ptt' ? handlePTTStart : undefined}
        onMouseUp={mode === 'ptt' ? handlePTTEnd : undefined}
        onTouchStart={mode === 'ptt' ? handlePTTStart : undefined}
        onTouchEnd={mode === 'ptt' ? handlePTTEnd : undefined}
        type="button"
        className={`relative w-12 h-12 rounded-2xl border flex items-center justify-center transition-all cursor-pointer ${btnColor}`}
        title={mode === 'ptt' ? '按住说话' : '语音功能'}
      >
        {icon}
      </motion.button>

      {mode === 'ptt' && !isOn && (
        <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] text-amber-400/60 whitespace-nowrap">按住说话</span>
      )}

      <AnimatePresence>
        {isOn && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap"
          >
            <span className="text-[12px] font-bold uppercase tracking-widest text-white/40">{config.label}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 8 }}
              className="absolute bottom-full mb-2 right-0 z-50 bg-zinc-900 border border-white/10 rounded-2xl p-1.5 shadow-2xl min-w-[130px]"
            >
              {MENU_ITEMS.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleMenuItem(item.id)}
                  className="flex items-center gap-3 w-full px-4 py-2.5 rounded-xl text-sm font-medium text-white/80 hover:bg-white/10 transition-colors whitespace-nowrap"
                >
                  <item.icon size={17} className="text-white/50" />
                  {item.label}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
