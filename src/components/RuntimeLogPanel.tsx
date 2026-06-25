import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, FileText, Pause, Play, RefreshCw, Server, Terminal } from 'lucide-react';

interface RuntimeLogSource {
  id: string;
  path: string;
  name: string;
  modifiedAt: string;
  size: number;
  lines: string[];
}

interface RuntimeLogPayload {
  runtime: {
    version?: string;
    pid?: number;
    startedAt?: string;
    uptimeSeconds?: number;
    nodeVersion?: string;
    platform?: string;
  };
  generatedAt: string;
  sources: RuntimeLogSource[];
}

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const formatUptime = (seconds?: number) => {
  if (!seconds || seconds < 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const classifyLine = (line: string) => {
  if (/\b(error|failed|fatal|exception|crash)\b/i.test(line)) return 'text-red-300 bg-red-500/10 border-red-500/20';
  if (/\b(warn|skipped|degraded|missing)\b/i.test(line)) return 'text-amber-200 bg-amber-500/10 border-amber-500/20';
  if (/\b(ready|running|connected|success|registered|discovered)\b/i.test(line)) return 'text-emerald-200 bg-emerald-500/10 border-emerald-500/20';
  if (/^\[(API_ROUTER|Socket|MCP|Scheduler|INFO)\]/.test(line)) return 'text-cyan-100/80 bg-cyan-500/5 border-cyan-500/10';
  return 'text-white/55 border-white/5';
};

export function RuntimeLogPanel({ t }: { t: any }) {
  const [payload, setPayload] = useState<RuntimeLogPayload | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const loadLogs = async () => {
    setError('');
    try {
      const res = await fetch('/api/runtime/logs?lines=320', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to load logs (${res.status})`);
      setPayload(data);
      setActiveSourceId(prev => prev || data.sources?.[0]?.id || '');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLogs();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void loadLogs(), 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const sources = payload?.sources || [];
  const activeSource = useMemo(
    () => sources.find(source => source.id === activeSourceId) || sources[0],
    [activeSourceId, sources],
  );
  const visibleLines = activeSource?.lines || [];
  const issueCount = visibleLines.filter(line => /\b(error|failed|fatal|exception|crash|warn)\b/i.test(line)).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950 text-white">
      <div className="shrink-0 border-b border-white/10 bg-white/[0.03] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-cyan-300">
              <Terminal size={15} />
              {t.runtimeLog || 'Run Log'}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-white/45">
              <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1">
                <Server size={12} /> PID {payload?.runtime?.pid || '-'}
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1">
                <Clock size={12} /> {formatUptime(payload?.runtime?.uptimeSeconds)}
              </span>
              <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1">
                {payload?.runtime?.nodeVersion || 'node'}
              </span>
              {issueCount > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-amber-200">
                  <AlertTriangle size={12} /> {issueCount}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-emerald-200">
                  <CheckCircle2 size={12} /> clean
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoRefresh(prev => !prev)}
              className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${autoRefresh ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200' : 'border-white/10 bg-white/5 text-white/45 hover:text-white'}`}
              title={autoRefresh ? 'Pause refresh' : 'Resume refresh'}
            >
              {autoRefresh ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button
              type="button"
              onClick={() => void loadLogs()}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
              title={t.refresh || 'Refresh'}
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr]">
        <aside className="min-h-0 overflow-y-auto border-r border-white/10 bg-black/20 p-3 custom-scrollbar">
          {sources.length === 0 && (
            <div className="rounded-lg border border-dashed border-white/10 px-3 py-8 text-center text-xs text-white/35">
              {loading ? 'Loading logs...' : 'No runtime logs found'}
            </div>
          )}
          <div className="space-y-2">
            {sources.map(source => {
              const active = source.id === activeSource?.id;
              return (
                <button
                  type="button"
                  key={source.id}
                  onClick={() => setActiveSourceId(source.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${active ? 'border-cyan-400/30 bg-cyan-400/10' : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.06]'}`}
                >
                  <div className="flex items-center gap-2 text-xs font-bold text-white/80">
                    <FileText size={13} className={active ? 'text-cyan-200' : 'text-white/35'} />
                    <span className="truncate">{source.name}</span>
                  </div>
                  <div className="mt-1 truncate text-[10px] text-white/35">{source.path}</div>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-white/30">
                    <span>{formatBytes(source.size)}</span>
                    <span>{source.lines.length} lines</span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-h-0 overflow-hidden">
          {error ? (
            <div className="m-5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
          ) : (
            <div className="h-full overflow-y-auto p-4 font-mono text-[11px] leading-relaxed custom-scrollbar">
              {visibleLines.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-white/35">
                  {loading ? 'Loading logs...' : 'This log is empty'}
                </div>
              ) : (
                visibleLines.map((line, index) => (
                  <div
                    key={`${activeSource?.id || 'log'}-${index}`}
                    className={`mb-1 rounded-md border px-2 py-1 ${classifyLine(line)}`}
                  >
                    <span className="mr-3 select-none text-white/20">{String(index + 1).padStart(3, '0')}</span>
                    <span className="whitespace-pre-wrap break-words">{line}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
