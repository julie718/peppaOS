import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Cpu, Terminal, FileText, Search, Globe, Wrench, CheckCircle, XCircle, Loader2 } from 'lucide-react';

export interface ExecutionEntry {
  id: string;
  name: string;
  arguments: Record<string, any>;
  result?: string;
  error?: string;
  timestamp: number;
  status: 'running' | 'done' | 'error';
}

const TOOL_ICONS: Record<string, React.ReactNode> = {
  read_file: <FileText size={14} />,
  write_file: <FileText size={14} />,
  search: <Search size={14} />,
  web_search: <Globe size={14} />,
  run_command: <Terminal size={14} />,
  default: <Cpu size={14} />,
};

function getToolIcon(name: string): React.ReactNode {
  for (const [key, icon] of Object.entries(TOOL_ICONS)) {
    if (name.includes(key)) return icon;
  }
  return TOOL_ICONS.default;
}

function formatArgs(args: Record<string, any>): string {
  const entries = Object.entries(args || {});
  if (entries.length === 0) return '';
  const first = entries[0];
  const val = typeof first[1] === 'string' ? first[1] : JSON.stringify(first[1]);
  const label = first[0].replace(/_/g, ' ');
  if (val.length > 60) return `${label}: ${val.slice(0, 60)}...`;
  return `${label}: ${val}`;
}

function formatResult(result?: string): string {
  if (!result) return '';
  const cleaned = result.replace(/\n/g, ' ').trim();
  if (cleaned.length > 80) return cleaned.slice(0, 80) + '...';
  return cleaned;
}

export function ExecutionStream({ entries }: { entries: ExecutionEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  if (entries.length === 0) return null;

  return (
    <div className="absolute inset-0 z-50 pointer-events-none flex flex-col justify-end pb-32">
      <div
        ref={scrollRef}
        className="px-12 py-6 space-y-3 overflow-y-auto pointer-events-auto max-h-[60vh] custom-scrollbar"
      >
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, x: -40, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.95 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-start gap-3 group"
            >
              {/* Status indicator */}
              <div className="flex-shrink-0 mt-0.5">
                {entry.status === 'running' ? (
                  <div className="w-5 h-5 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center">
                    <Loader2 size={10} className="text-cyan-400 animate-spin" />
                  </div>
                ) : entry.status === 'error' ? (
                  <div className="w-5 h-5 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center">
                    <XCircle size={10} className="text-red-400" />
                  </div>
                ) : (
                  <div className="w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
                    <CheckCircle size={10} className="text-emerald-400" />
                  </div>
                )}
              </div>

              {/* Content */}
              <div className={`flex-1 min-w-0 rounded-2xl px-4 py-2.5 border backdrop-blur-xl transition-all ${
                entry.status === 'running'
                  ? 'bg-cyan-500/5 border-cyan-500/20'
                  : entry.status === 'error'
                  ? 'bg-red-500/5 border-red-500/20'
                  : 'bg-white/5 border-white/10'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-cyan-400/80">{getToolIcon(entry.name)}</span>
                  <span className="text-xs font-black uppercase tracking-widest text-white/80">
                    {entry.name.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[12px] font-mono text-white/45">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </div>

                {/* Arguments */}
                {entry.arguments && Object.keys(entry.arguments).length > 0 && (
                  <div className="text-xs font-mono text-white/40 truncate mb-1 pl-7">
                    {formatArgs(entry.arguments)}
                  </div>
                )}

                {/* Result */}
                {(entry.result || entry.error) && (
                  <div className={`text-xs font-mono pl-7 truncate ${
                    entry.error ? 'text-red-400/80' : 'text-emerald-400/80'
                  }`}>
                    {entry.error ? entry.error : formatResult(entry.result)}
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Scanline overlay */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />
    </div>
  );
}
