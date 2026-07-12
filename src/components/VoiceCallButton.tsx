import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, Phone, Camera, Loader2, Volume2 } from 'lucide-react';
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

type Mode = 'idle' | 'call';

const MENU_ITEMS = [
  { id: 'call',   icon: Phone,  label: '实时通话' },
  { id: 'camera', icon: Camera, label: '拍照识别'  },
];

export function VoiceCallButton({ callState, audioLevel, onStart, onEnd, hasVoice = false, className = '' }: VoiceCallButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('idle');
  const isActive = callState !== 'idle' && callState !== 'passive';
  const isOn = callState !== 'idle';
  const t = useT();

  const stateConfig: Record<CallState, { icon: React.ReactNode; color: string; label: string }> = {
    idle: { icon: <Mic size={20} />, color: 'bg-white/5 text-white/40 border-white/10', label: t.callStart || 'Start' },
    connecting: { icon: <Loader2 size={20} className="animate-spin" />, color: 'bg-celestial-saturn/10 text-celestial-saturn border-celestial-saturn/30', label: t.callConnecting || 'Connecting...' },
    listening: { icon: <Mic size={20} />, color: 'bg-celestial-saturn text-black border-celestial-saturn shadow-[0_0_20px_rgba(255,204,0,0.4)]', label: t.callListening || 'Listening' },
    thinking: { icon: <Loader2 size={20} className="animate-spin" />, color: 'bg-celestial-mars/10 text-celestial-mars border-celestial-mars/30', label: t.callThinking || 'Thinking' },
    speaking: { icon: <Volume2 size={20} />, color: 'bg-celestial-glow/10 text-celestial-glow border-celestial-glow/30', label: t.callSpeaking || 'Speaking' },
    queued: { icon: <Loader2 size={20} className="animate-spin" />, color: 'bg-purple-500/10 text-purple-400 border-purple-500/30', label: t.callQueued || 'Queued' },
    passive: { icon: <motion.div animate={{ opacity: [0.15, 0.35, 0.15] }} transition={{ duration: 3, repeat: Infinity }}><Mic size={20} /></motion.div>, color: 'bg-white/5 text-white/45 border-white/5', label: t.callPassive || 'Passive' },
  };

  const config = stateConfig[callState];
  const icon = mode === 'call' ? <Phone size={20} /> : config.icon;

  const handleClick = () => {
    if (isOn) { onEnd(); setMode('idle'); return; }
    setMenuOpen(true);
  };

  const handleMenuItem = (id: string) => {
    setMenuOpen(false);
    if (id === 'call') { setMode('call'); onStart(); }
    else if (id === 'camera') { openCamera(); }
  };

  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream; video.play();
      video.onloadeddata = () => {
        const c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext('2d')!.drawImage(video, 0, 0);
        const b64 = c.toDataURL('image/jpeg', 0.8);
        stream.getTracks().forEach(t => t.stop());
        window.dispatchEvent(new CustomEvent('peppa:camera-capture', { detail: { imageBase64: b64 } }));
      };
    } catch {}
  };

  return (
    <div className={`relative ${className}`}>
      <AnimatePresence>
        {isActive && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1 + audioLevel * 0.3, opacity: 0.15 + audioLevel * 0.2 }}
            exit={{ scale: 0.8, opacity: 0 }}
            className={`absolute inset-0 rounded-full ${
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
        type="button"
        className={`relative w-12 h-12 rounded-2xl border flex items-center justify-center transition-all cursor-pointer ${config.color}`}
        title="语音功能"
      >
        {icon}
      </motion.button>

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
