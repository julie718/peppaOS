// Infinite Canvas Workbench — main orchestrator component
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Menu } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { useCanvasSocket } from './useCanvasSocket';
import { CanvasViewport } from './CanvasViewport';
import { CanvasSessionPanel } from './CanvasSessionPanel';
import { CanvasInputBar } from './CanvasInputBar';
import { CanvasCard, CanvasSessionSummary } from './types';

interface CanvasWorkbenchProps {
  isOpen: boolean;
  onClose: () => void;
  t: any;
  user: any;
}

export function CanvasWorkbench({ isOpen, onClose, t, user }: CanvasWorkbenchProps) {
  const socket = useSocket();
  const [sessions, setSessions] = useState<CanvasSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [cards, setCards] = useState<CanvasCard[]>([]);
  const [showSessionPanel, setShowSessionPanel] = useState(false);
  const [statusText, setStatusText] = useState('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardsRef = useRef<CanvasCard[]>([]);

  // Keep cardsRef in sync for save
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  // Socket → canvas cards
  const onCardsReceived = useCallback((newCards: CanvasCard[]) => {
    setCards(newCards);
  }, []);

  const onStatusChange = useCallback((status: string) => {
    if (status === 'thinking') setStatusText('Working...');
    else if (status === 'responding') setStatusText('Responding...');
    else setStatusText('');
  }, []);

  const { submitTask } = useCanvasSocket({
    socket,
    onCards: onCardsReceived,
    onStatusChange,
  });

  // Load session list on mount
  useEffect(() => {
    fetch('/api/canvas/sessions')
      .then(r => r.json())
      .then(data => setSessions(data.sessions || []))
      .catch(() => {});
  }, []);

  // Auto-save with debounce
  const autoSave = useCallback(() => {
    if (!currentSessionId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await fetch(`/api/canvas/sessions/${currentSessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cards: cardsRef.current }),
        });
      } catch {}
    }, 2000);
  }, [currentSessionId]);

  // Trigger auto-save when cards change
  useEffect(() => {
    if (currentSessionId && cards.length > 0) {
      autoSave();
    }
  }, [cards, currentSessionId, autoSave]);

  // Create new session
  const handleNewSession = useCallback(async () => {
    try {
      const res = await fetch('/api/canvas/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const session = await res.json();
      setCurrentSessionId(session.id);
      setCards([]);
      setSessions(prev => [
        { id: session.id, title: session.title, taskText: session.taskText, status: session.status, cardCount: 0, createdAt: session.createdAt, updatedAt: session.updatedAt },
        ...prev,
      ]);
      setShowSessionPanel(false);
    } catch {}
  }, []);

  // Load existing session
  const handleLoadSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/canvas/sessions/${id}`);
      const session = await res.json();
      setCurrentSessionId(session.id);
      setCards(session.cards || []);
      setShowSessionPanel(false);
    } catch {}
  }, []);

  // Delete session
  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await fetch(`/api/canvas/sessions/${id}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.id !== id));
      if (currentSessionId === id) {
        setCurrentSessionId(null);
        setCards([]);
      }
    } catch {}
  }, [currentSessionId]);

  // Handle task submission from input bar
  const handleTaskSubmit = useCallback(async (text: string) => {
    // If no active session, create one first
    if (!currentSessionId) {
      try {
        const res = await fetch('/api/canvas/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskText: text, title: text.slice(0, 60) }),
        });
        const session = await res.json();
        setCurrentSessionId(session.id);
        setSessions(prev => [
          { id: session.id, title: session.title, taskText: session.taskText, status: session.status, cardCount: 0, createdAt: session.createdAt, updatedAt: session.updatedAt },
          ...prev,
        ]);
        // Update session title
        fetch(`/api/canvas/sessions/${session.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: text.slice(0, 60), taskText: text }),
        }).catch(() => {});
      } catch { return; }
    } else {
      // Update existing session
      fetch(`/api/canvas/sessions/${currentSessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskText: text }),
      }).catch(() => {});
    }

    submitTask(text);
  }, [currentSessionId, submitTask]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showSessionPanel) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, showSessionPanel]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[220] bg-[#0a0a10]"
        >
          {/* Top bar */}
          <div className="absolute top-0 left-0 right-0 z-40 h-12 flex items-center justify-between px-4 bg-gradient-to-b from-black/60 to-transparent">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowSessionPanel(true)}
                className="w-9 h-9 flex items-center justify-center rounded-xl text-white/50 hover:text-white hover:bg-white/10 transition-colors"
              >
                <Menu size={18} />
              </button>
              <span className="text-sm font-medium text-white/70">
                {t.canvasWorkbench || 'Canvas Workbench'}
              </span>
              {currentSessionId && (
                <span className="text-[10px] text-white/30 bg-white/[0.04] rounded-lg px-2 py-0.5">
                  {sessions.find(s => s.id === currentSessionId)?.title?.slice(0, 30) || 'Untitled'}
                </span>
              )}
              {statusText && (
                <span className="text-[10px] text-amber-400/70 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  {statusText}
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              className="w-9 h-9 flex items-center justify-center rounded-xl text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Canvas */}
          <CanvasViewport cards={cards} />

          {/* Session panel overlay */}
          <CanvasSessionPanel
            isOpen={showSessionPanel}
            onClose={() => setShowSessionPanel(false)}
            sessions={sessions}
            currentId={currentSessionId}
            onSelect={handleLoadSession}
            onNew={handleNewSession}
            onDelete={handleDeleteSession}
            t={t}
          />

          {/* Input bar */}
          <CanvasInputBar
            onSend={handleTaskSubmit}
            disabled={statusText !== ''}
            t={t}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
