import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import { BarChart3, RefreshCw, Zap, TrendingUp, Clock } from 'lucide-react';

interface ProviderStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

interface DailyStats {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface UsageData {
  byProvider: Record<string, ProviderStats>;
  daily: DailyStats[];
  grandTotal: number;
  days: number;
  recordCount: number;
}

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen / DashScope',
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
};

const PROVIDER_COLORS: Record<string, string> = {
  deepseek: '#4f46e5',
  qwen: '#06b6d4',
  openai: '#10b981',
  gemini: '#8b5cf6',
  anthropic: '#f59e0b',
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export const TokenDashboard: React.FC = () => {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/llm/usage?days=${days}`, { credentials: 'include' });
      if (!resp.ok) throw new Error(resp.status === 401 ? 'Login required' : `HTTP ${resp.status}`);
      const res = await resp.json();
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Failed to load usage data');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  const maxDaily = data?.daily
    ? Math.max(...data.daily.map(d => d.totalTokens), 1)
    : 1;

  const providers = data?.byProvider ? Object.entries(data.byProvider) : [];

  return (
    <div className="h-full flex flex-col text-white">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-celestial-glow/10 border border-celestial-glow/20 flex items-center justify-center">
            <Zap size={20} className="text-celestial-glow" />
          </div>
          <div>
            <h2 className="text-lg font-black tracking-tight">Token Usage</h2>
            <p className="text-[10px] text-white/30 font-medium">API consumption across all LLM providers</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${
                days === d
                  ? 'bg-white/15 text-white border border-white/10'
                  : 'text-white/30 hover:text-white/60 border border-transparent'
              }`}
            >
              {d}d
            </button>
          ))}
          <button
            onClick={fetchUsage}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-all"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Content */}
      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <RefreshCw size={24} className="text-white/20 animate-spin" />
        </div>
      ) : error && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col gap-4 overflow-auto custom-scrollbar pr-1">
          {/* Grand total card */}
          <div className="glass rounded-2xl p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <TrendingUp size={18} className="text-celestial-saturn" />
              <span className="text-xs font-bold text-white/40 uppercase tracking-wider">Total Consumption</span>
            </div>
            <div className="text-right">
              <span className="text-2xl font-black tracking-tight">{formatTokens(data?.grandTotal || 0)}</span>
              <p className="text-[10px] text-white/20">{data?.recordCount || 0} API calls</p>
            </div>
          </div>

          {/* Per-provider breakdown */}
          <div className="glass rounded-2xl p-5">
            <h3 className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-4 flex items-center gap-2">
              <BarChart3 size={12} />
              By Provider
            </h3>
            {providers.length === 0 ? (
              <p className="text-white/20 text-xs">No usage data yet. Start chatting to see token consumption.</p>
            ) : (
              <div className="space-y-3">
                {providers.map(([provider, stats]) => {
                  const maxPct = providers.length > 0
                    ? (stats.totalTokens / Math.max(...providers.map(([, s]) => s.totalTokens), 1)) * 100
                    : 0;
                  return (
                    <div key={provider}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold">{PROVIDER_LABELS[provider] || provider}</span>
                        <span className="text-[10px] text-white/40 font-mono">
                          {formatTokens(stats.totalTokens)} tokens ({stats.calls} calls)
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${maxPct}%` }}
                          className="h-full rounded-full"
                          style={{ backgroundColor: PROVIDER_COLORS[provider] || '#888' }}
                        />
                      </div>
                      <div className="flex gap-3 mt-1 text-[9px] text-white/20 font-mono">
                        <span>In: {formatTokens(stats.promptTokens)}</span>
                        <span>Out: {formatTokens(stats.completionTokens)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Daily chart */}
          <div className="glass rounded-2xl p-5 flex-1">
            <h3 className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Clock size={12} />
              Daily Trend
            </h3>
            {!data?.daily || data.daily.length === 0 ? (
              <p className="text-white/20 text-xs">No daily data available.</p>
            ) : (
              <div className="flex items-end gap-1 h-32">
                {data.daily.map(d => {
                  const h = (d.totalTokens / maxDaily) * 100;
                  return (
                    <div
                      key={d.date}
                      className="flex-1 flex flex-col items-center gap-1 group relative"
                    >
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: `${Math.max(h, 1)}%` }}
                        className="w-full rounded-t-sm bg-celestial-glow/30 hover:bg-celestial-glow/60 transition-colors min-h-[2px]"
                      />
                      <span className="text-[7px] text-white/10 group-hover:text-white/40 font-mono transition-colors">
                        {d.date.slice(5)}
                      </span>
                      {/* Tooltip */}
                      <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-black/90 rounded text-[9px] font-mono text-white opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap transition-opacity">
                        {formatTokens(d.totalTokens)} tokens
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
