import { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, Check, X, AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';
import { motion, AnimatePresence } from 'motion/react';

interface PendingConfirm {
  correlationId: string;
  name: string;
  arguments: Record<string, any>;
}

/**
 * Listens for agent:confirm_tool socket events and renders a modal dialog
 * asking the user to approve or deny tool execution.
 * Must receive the SAME socket instance used by the task handler,
 * since confirm_tool events are emitted on the task socket specifically.
 */
export function ToolConfirmDialog({ socket }: { socket: any }) {
  const [pending, setPending] = useState<PendingConfirm[]>([]);

  useEffect(() => {
    if (!socket) return;

    const handleConfirm = (data: { correlationId: string; name: string; arguments: Record<string, any> }) => {
      setPending(prev => [...prev, data]);
    };

    socket.on('agent:confirm_tool', handleConfirm);
    return () => { socket.off('agent:confirm_tool', handleConfirm); };
  }, [socket]);

  const respond = useCallback((correlationId: string, allowed: boolean) => {
    socket?.emit(`tool:confirm_result:${correlationId}`, { correlationId, allowed });
    setPending(prev => prev.filter(p => p.correlationId !== correlationId));
  }, [socket]);

  const current = pending[0];

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => respond(current.correlationId, false)}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            onClick={e => e.stopPropagation()}
            className="bg-zinc-900 border border-yellow-500/30 rounded-[2rem] p-8 max-w-md w-full mx-4 shadow-2xl"
          >
            <div className="flex items-center gap-3 mb-6">
              <div className="p-3 bg-yellow-500/10 rounded-2xl">
                <ShieldAlert size={24} className="text-yellow-400" />
              </div>
              <div>
                <h3 className="text-sm font-black uppercase tracking-widest text-yellow-400">Tool Authorization</h3>
                <p className="text-[10px] text-white/30 mt-0.5">This tool requires your explicit permission</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={14} className="text-yellow-400" />
                  <span className="text-xs font-bold text-white/80 font-mono">{current.name}</span>
                </div>
                {Object.keys(current.arguments).length > 0 && (
                  <pre className="text-[10px] text-white/40 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto custom-scrollbar">
                    {JSON.stringify(current.arguments, null, 2)}
                  </pre>
                )}
              </div>

              {pending.length > 1 && (
                <p className="text-[10px] text-white/20 text-center">
                  +{pending.length - 1} more tool{pending.length > 2 ? 's' : ''} waiting
                </p>
              )}

              <div className="flex items-center gap-3">
                <Button
                  onClick={() => respond(current.correlationId, false)}
                  className="flex-1 bg-white/5 text-white/60 hover:bg-white/10 font-bold text-xs px-4 py-3 rounded-xl border border-white/10 transition-all"
                >
                  <X size={14} className="mr-1" /> Deny
                </Button>
                <Button
                  onClick={() => respond(current.correlationId, true)}
                  className="flex-1 bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 font-bold text-xs px-4 py-3 rounded-xl border border-yellow-500/30 transition-all"
                >
                  <Check size={14} className="mr-1" /> Allow
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
