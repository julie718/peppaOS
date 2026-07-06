import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Crown, Zap, Check, Loader2, Flame, Shield, Brain, Sparkles } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { toast } from 'sonner';

interface PlanInfo {
  id: string;
  name: string;
  tier: string;
  monthlyTokens: number;
  llmProviders: string[];
  priceCNY: number;
  description: string;
}

interface SubStatus {
  subscription: {
    planId: string; status: string;
    tokensUsedThisMonth: number; monthlyTokenCap: number;
    startedAt: string | null; expiresAt: string | null;
  };
  plan: PlanInfo;
  usage: { used: number; cap: number; remaining: number };
}

const COLORS: Record<string, string> = {
  free: 'bg-white/5 border-white/10',
  light: 'bg-blue-500/5 border-blue-500/30',
  pro: 'bg-purple-500/5 border-purple-500/30',
  org: 'bg-amber-500/5 border-amber-500/30',
};

const ACCENTS: Record<string, string> = {
  free: 'text-white/40',
  light: 'text-blue-400',
  pro: 'text-purple-400',
  org: 'text-amber-400',
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function SubscriptionPanel({ t }: { t: any }) {
  const { user } = useApp();
  const [status, setStatus] = useState<SubStatus | null>(null);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'status' | 'plans'>('status');

  useEffect(() => {
    Promise.all([
      fetch('/api/subscription/status', { credentials: 'include' }).then(r => r.ok ? r.json() : null),
      fetch('/api/subscription/plans', { credentials: 'include' }).then(r => r.ok ? r.json() : null),
    ]).then(([s, p]) => {
      if (s) setStatus(s);
      else setError('Failed to load subscription status');
      if (p?.plans) setPlans(p.plans);
    }).catch((e) => {
      setError(e.message || 'Network error');
    }).finally(() => setLoading(false));
  }, []);

  if (!user) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-white/40 text-sm">Login to view subscription.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-white/45" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p className="text-red-400 text-sm">{error}</p>
        <button onClick={() => { setError(null); setLoading(true); window.location.reload(); }} className="text-xs text-white/40 hover:text-white/60 underline">Retry</button>
      </div>
    );
  }

  if (!status && plans.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p className="text-white/55 text-sm">No subscription data available.</p>
        <p className="text-white/45 text-xs">Check that the server is running on port 3000.</p>
      </div>
    );
  }

  const currentPlan = status?.plan;
  const currentUsage = status?.usage;
  const pct = currentUsage ? Math.round((currentUsage.used / currentUsage.cap) * 100) : 0;

  return (
    <div className="h-full flex flex-col bg-zinc-950/60 text-white overflow-y-auto">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-white/5">
        <Crown size={18} className="text-celestial-saturn" />
        <h2 className="text-sm font-bold text-white/90">Peppa Subscription</h2>
        <div className="flex-1" />
        <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
          {(['status', 'plans'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-md text-xs font-bold uppercase transition-all ${
                tab === t ? 'bg-white/10 text-white' : 'text-white/55'
              }`}
            >
              {t === 'status' ? 'Status' : 'Plans'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'status' && currentPlan && (
        <div className="p-6 space-y-6">
          {/* Current plan card */}
          <div className={`p-6 rounded-3xl border ${COLORS[currentPlan.tier] || COLORS.free}`}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className={`text-xs font-black uppercase tracking-widest ${ACCENTS[currentPlan.tier] || ACCENTS.free}`}>
                  {currentPlan.tier}
                </span>
                <h3 className="text-2xl font-black tracking-tight mt-1">{currentPlan.name}</h3>
              </div>
              {currentPlan.priceCNY > 0 && (
                <span className="text-lg font-black">¥{currentPlan.priceCNY}<span className="text-xs font-normal text-white/55">/mo</span></span>
              )}
              {currentPlan.priceCNY === 0 && (
                <span className="text-sm font-bold text-white/55">Free</span>
              )}
            </div>

            <p className="text-xs text-white/40 mb-6">{currentPlan.description}</p>

            {/* Token usage bar */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-white/40 font-bold uppercase tracking-widest">Tokens</span>
                <span className="text-white/60 font-mono">{fmtTokens(currentUsage?.used || 0)} / {fmtTokens(currentUsage?.cap || 0)}</span>
              </div>
              <div className="h-2 w-full bg-white/5 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(pct, 100)}%` }}
                  className={`h-full rounded-full ${pct > 90 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-celestial-saturn'}`}
                />
              </div>
              <div className="flex justify-between text-xs text-white/45">
                <span>{pct}% used</span>
                <span>{fmtTokens(currentUsage?.remaining || 0)} remaining</span>
              </div>
            </div>
          </div>

          {/* Features */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'LLM Providers', value: currentPlan.llmProviders.join(', ') },
              { label: 'Monthly Tokens', value: fmtTokens(currentPlan.monthlyTokens) },
              { label: 'Max Agents', value: String(status?.subscription ? '—' : currentPlan.llmProviders.length) },
              { label: 'Status', value: status?.subscription?.status || 'active' },
            ].map((f, i) => (
              <div key={i} className="p-3 bg-white/5 rounded-xl">
                <div className="text-xs font-bold text-white/45 uppercase">{f.label}</div>
                <div className="text-xs font-bold text-white/70 mt-0.5">{f.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'plans' && (
        <div className="p-6 grid grid-cols-1 gap-4">
          {plans.map(plan => {
            const isCurrent = plan.id === currentPlan?.id;
            return (
              <div
                key={plan.id}
                className={`p-5 rounded-2xl border transition-all ${isCurrent ? 'border-celestial-saturn/50 bg-celestial-saturn/5' : 'bg-white/[0.02] border-white/5 hover:border-white/10'}`}
              >
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <span className={`text-[12px] font-black uppercase tracking-widest ${ACCENTS[plan.tier] || ACCENTS.free}`}>
                      {plan.tier}
                    </span>
                    <h4 className="text-sm font-bold mt-0.5">{plan.name}</h4>
                  </div>
                  <div className="text-right">
                    {plan.priceCNY > 0 ? (
                      <span className="text-sm font-black">¥{plan.priceCNY}<span className="text-[12px] font-normal text-white/55">/mo</span></span>
                    ) : (
                      <span className="text-xs font-bold text-white/55">Free</span>
                    )}
                  </div>
                </div>

                <p className="text-xs text-white/55 mb-3">{plan.description}</p>

                <div className="flex flex-wrap gap-1 mb-3">
                  {plan.llmProviders.map(p => (
                    <span key={p} className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-white/40 font-bold uppercase">{p}</span>
                  ))}
                </div>

                {isCurrent ? (
                  <span className="text-[12px] font-bold text-celestial-saturn uppercase tracking-widest">Current Plan</span>
                ) : (
                  <button
                    onClick={() => toast.info(t.contactAdminUpgrade || 'Contact admin to upgrade: maoxiansheng946@github')}
                    className="text-[12px] font-bold text-white/55 hover:text-white/60 uppercase tracking-widest transition-colors"
                  >
                    Upgrade →
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
