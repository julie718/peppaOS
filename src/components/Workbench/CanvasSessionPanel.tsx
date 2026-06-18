// Canvas session panel — sidebar for creating, loading, deleting canvas sessions
import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, Trash2, X, Layers, Clock } from 'lucide-react';
import { CanvasSessionSummary } from './types';
import { appConfirm } from '@/lib/appConfirm';

interface CanvasSessionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: CanvasSessionSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  t: any;
}

export function CanvasSessionPanel({
  isOpen, onClose, sessions, currentId, onSelect, onNew, onDelete, t,
}: CanvasSessionPanelProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-emerald-400';
      case 'completed': return 'bg-blue-400';
      case 'archived': return 'bg-white/30';
      default: return 'bg-white/30';
    }
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[240] bg-black/45 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            initial={{ x: -320 }}
            animate={{ x: 0 }}
            exit={{ x: -320 }}
            transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            className="lumi-surface fixed bottom-0 left-0 top-0 z-[250] flex w-[320px] flex-col rounded-none border-y-0 border-l-0 bg-black/85"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-teal-300/15 bg-teal-400/10 text-teal-200">
                  <Layers size={18} />
                </span>
                <span className="text-sm font-black uppercase tracking-[0.12em] text-white/80">
                  {t.canvasWorkbench || 'Canvas Workbench'}
                </span>
              </div>
              <button
                onClick={onClose}
                className="lumi-icon-button h-8 w-8"
              >
                <X size={16} />
              </button>
            </div>

            {/* New canvas button */}
            <div className="px-4 py-3">
              <button
                onClick={onNew}
                className="lumi-button-primary w-full border-teal-400/25 bg-teal-500/15 text-teal-300 hover:bg-teal-500/25"
              >
                <Plus size={16} />
                {t.canvasNewSession || 'New Canvas'}
              </button>
            </div>

            {/* Session list */}
            <div className="custom-scrollbar flex-1 overflow-y-auto px-3 pb-3">
              {sessions.length === 0 ? (
                <div className="lumi-panel py-12 text-center text-sm text-white/30">
                  {t.canvasNoSessions || 'No canvas sessions yet'}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {sessions.map(session => (
                    <div
                      key={session.id}
                      onClick={() => onSelect(session.id)}
                      className={`group relative flex cursor-pointer flex-col gap-0.5 rounded-2xl border px-3 py-2.5 transition-colors ${
                        session.id === currentId
                          ? 'border-teal-400/25 bg-teal-500/15'
                          : 'border-transparent hover:border-white/[0.08] hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(session.status)}`} />
                        <span className="text-sm text-white/80 truncate flex-1">
                          {session.title || session.taskText?.slice(0, 40) || (t.canvasNewSession || 'Untitled')}
                        </span>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (await appConfirm({
                              title: t.canvasDeleteConfirm || 'Delete this canvas session?',
                              message: t.canvasDeleteConfirm || 'Delete this canvas session?',
                              confirmText: t.delete || 'Delete',
                              cancelText: t.cancel || 'Cancel',
                              tone: 'danger',
                            })) {
                              onDelete(session.id);
                            }
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-white/25 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-white/35 pl-4">
                        <span className="flex items-center gap-1">
                          <Layers size={10} /> {session.cardCount || 0} cards
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock size={10} /> {formatDate(session.updatedAt || session.createdAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
