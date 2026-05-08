import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Wrench, Shield, AlertTriangle, CheckCircle, Loader2, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';

interface ToolInfo {
  name: string;
  description: string;
  permission: string;
  securityLevel: 'safe' | 'confirm' | 'forbidden';
}

const SECURITY_COLORS: Record<string, { bg: string; border: string; text: string; icon: React.ReactNode }> = {
  safe: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', icon: <CheckCircle size={10} /> },
  confirm: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400', icon: <AlertTriangle size={10} /> },
  forbidden: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400', icon: <EyeOff size={10} /> },
};

export function ToolPanel({ t }: { t?: any }) {
  const { toolOverrides, setToolOverride } = useApp();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/tools')
      .then(r => r.json())
      .then(data => setTools(data || []))
      .catch(() => toast.error(t?.failedToLoadTools || 'Failed to load tools'))
      .finally(() => setLoading(false));
  }, []);

  const safeTools = tools.filter(t => t.securityLevel === 'safe');
  const confirmTools = tools.filter(t => t.securityLevel === 'confirm');
  const forbiddenTools = tools.filter(t => t.securityLevel === 'forbidden');

  const isEnabled = (name: string) => {
    const override = toolOverrides[name];
    if (override) return override.enabled;
    return true; // enabled by default
  };

  const toggleTool = (name: string) => {
    const next = !isEnabled(name);
    setToolOverride(name, { enabled: next });
  };

  const sections = [
    { label: 'autoExecute', items: safeTools, color: 'emerald' },
    { label: 'requireConfirmation', items: confirmTools, color: 'amber' },
    { label: 'forbidden', items: forbiddenTools, color: 'red' },
  ];

  return (
    <div className="h-full flex flex-col bg-zinc-950/60 backdrop-blur-xl text-white overflow-y-auto">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-white/5">
        <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
          <Wrench size={20} className="text-amber-400" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-white/90">{t?.toolControlPanel || 'Tool Control Panel'}</h2>
          <p className="text-[10px] text-white/30">
            {loading ? (t?.loading || 'Loading...') : `${tools.length} ${t?.toolsRegistered || 'tools registered'}`}
          </p>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-white/30">
            <Loader2 size={24} className="animate-spin mr-2" /> {t?.loadingTools || 'Loading tools...'}
          </div>
        ) : (
          sections.map(section => {
            const colorKey = section.color as keyof typeof SECURITY_COLORS;
            return (
              <div key={section.label} className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full bg-${section.color}-500`} />
                  <span className="text-[10px] font-black uppercase text-white/30 tracking-wider">
                    {t?.[section.label] || section.label} ({section.items.length})
                  </span>
                </div>
                {section.items.length === 0 ? (
                  <p className="text-[10px] text-white/15 italic px-4 py-2">{t?.noToolsInCategory || 'No tools in this category'}</p>
                ) : (
                <div className="space-y-1">
                  {section.items.map(tool => {
                    const sec = SECURITY_COLORS[tool.securityLevel] || SECURITY_COLORS.confirm;
                    return (
                      <div
                        key={tool.name}
                        className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                          isEnabled(tool.name)
                            ? 'bg-white/5 border-white/5 hover:bg-white/10'
                            : 'bg-white/[0.02] border-white/[0.02] opacity-40'
                        }`}
                      >
                        <div className={`flex-shrink-0 w-8 h-8 rounded-lg ${sec.bg} ${sec.border} border flex items-center justify-center`}>
                          {sec.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-white/80 font-mono">{tool.name}</span>
                            <span className={`text-[8px] px-1.5 py-0.5 rounded-md font-black uppercase border ${sec.bg} ${sec.border} ${sec.text}`}>
                              {tool.securityLevel}
                            </span>
                            <span className="text-[8px] text-white/20 uppercase">{tool.permission}</span>
                          </div>
                          <p className="text-[10px] text-white/30 mt-0.5 truncate">{tool.description}</p>
                        </div>
                        <button
                          onClick={() => toggleTool(tool.name)}
                          className={`flex-shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${
                            isEnabled(tool.name) ? 'bg-emerald-500/60' : 'bg-white/10'
                          }`}
                        >
                          <motion.div
                            animate={{ x: isEnabled(tool.name) ? 16 : 0 }}
                            className={`w-4 h-4 rounded-full ${isEnabled(tool.name) ? 'bg-white' : 'bg-white/30'}`}
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
