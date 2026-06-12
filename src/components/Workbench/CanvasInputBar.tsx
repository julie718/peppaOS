// Canvas input bar — fixed bottom input for sending tasks
import React, { useState, useRef, useCallback } from 'react';
import { Send, Mic } from 'lucide-react';

interface CanvasInputBarProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  t: any;
}

export function CanvasInputBar({ onSend, disabled, t }: CanvasInputBarProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  }, [text, disabled, onSend]);

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
        <div className="flex items-end gap-2 bg-black/60 backdrop-blur-2xl border border-white/[0.08] rounded-2xl px-4 py-3 shadow-2xl">
          <textarea
            ref={inputRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={t.canvasTaskPlaceholder || 'Describe your task...'}
            disabled={disabled}
            rows={1}
            className="flex-1 bg-transparent text-sm text-white/90 placeholder:text-white/30 resize-none outline-none max-h-[120px] py-0.5"
          />
          <div className="flex items-center gap-1.5">
            <button
              className="w-9 h-9 flex items-center justify-center rounded-xl text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
              title="Voice input (coming soon)"
            >
              <Mic size={17} />
            </button>
            <button
              onClick={handleSend}
              disabled={!text.trim() || disabled}
              className="w-9 h-9 flex items-center justify-center rounded-xl bg-teal-500/20 border border-teal-400/30 text-teal-400 hover:bg-teal-500/40 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
