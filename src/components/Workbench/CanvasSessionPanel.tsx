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
            className="fixed inset-0 bg-black/40 z-[240]"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            initial={{ x: -320 }}
            animate={{ x: 0 }}
            exit={{ x: -320 }}
            transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            className="fixed left-0 top-0 bottom-0 w-[300px] z-[250] bg-black/90 backdrop-blur-2xl border-r border-white/[0.06] flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
              <div className="flex items-center gap-2">
                <Layers size={18} className="text-teal-400" />
                <span className="text-sm font-semibold text-white/80">
                  {t.canvasWorkbench || 'Canvas Workbench'}
                </span>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* New canvas button */}
            <div className="px-4 py-3">
              <button
                onClick={onNew}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-teal-500/15 border border-teal-400/20 text-teal-400 hover:bg-teal-500/25 hover:border-teal-400/40 transition-all text-sm font-medium"
              >
                <Plus size={16} />
                {t.canvasNewSession || 'New Canvas'}
              </button>
            </div>

            {/* Session list */}
            <div className="flex-1 overflow-y-auto px-3 pb-3">
              {sessions.length === 0 ? (
                <div className="text-center py-12 text-white/25 text-sm">
                  {t.canvasNoSessions || 'No canvas sessions yet'}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {sessions.map(session => (
                    <div
                      key={session.id}
                      onClick={() => onSelect(session.id)}
                      className={`group relative flex flex-col gap-0.5 px-3 py-2.5 rounded-xl cursor-pointer transition-all ${
                        session.id === currentId
                          ? 'bg-teal-500/15 border border-teal-400/25'
                          : 'hover:bg-white/[0.04] border border-transparent'
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
                          className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-all"
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
