import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Bot,
  CheckCircle,
  Clock,
  Download,
  Loader2,
  Package,
  Search,
  Send,
  Tag,
  X,
} from 'lucide-react';
import { useT } from '../../lib/useT';
import { useSocket } from '../../hooks/useSocket';

interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  status: string;
  authorId: string;
  downloadCount: number;
  version: number;
  createdAt: string;
}

type InstalledAgent = { id: string; name: string };
type Feedback = { type: 'success' | 'error'; text: string; agentId?: string };

export function TemplateMarketplace() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const socket = useSocket();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Template | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [installedAgentsByTemplate, setInstalledAgentsByTemplate] = useState<Record<string, InstalledAgent>>({});

  const loadInstalledAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents', { credentials: 'include' });
      const data = await res.json().catch(() => []);
      if (!res.ok) return;
      const agents = Array.isArray(data) ? data : data.agents || [];
      const installed: Record<string, InstalledAgent> = {};
      for (const agent of agents) {
        if (!agent?.installedTemplateId || !agent?.id || agent.status === 'terminated') continue;
        installed[String(agent.installedTemplateId)] = {
          id: String(agent.id),
          name: String(agent.name || ui('团队智能体', 'Team agent')),
        };
      }
      setInstalledAgentsByTemplate(installed);
    } catch {
      // Team state is a convenience; failing to read it should not block templates.
    }
  }, [ui]);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/org/templates?status=published', { credentials: 'include' });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error((data as any).error || ui(`模板加载失败（${res.status}）`, `Failed to load templates (${res.status})`));
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, [ui]);

  useEffect(() => {
    void loadTemplates();
    void loadInstalledAgents();
  }, [loadInstalledAgents, loadTemplates]);

  useEffect(() => {
    if (!socket) return;
    const refresh = () => void loadTemplates();
    socket.on('template:published', refresh);
    socket.on('template:status', refresh);
    socket.on('agent:created', loadInstalledAgents);
    socket.on('agent:removed', loadInstalledAgents);
    return () => {
      socket.off('template:published', refresh);
      socket.off('template:status', refresh);
      socket.off('agent:created', loadInstalledAgents);
      socket.off('agent:removed', loadInstalledAgents);
    };
  }, [loadInstalledAgents, loadTemplates, socket]);

  const categories = useMemo(() => [...new Set(templates.map(item => item.category).filter(Boolean))], [templates]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return templates.filter(template => {
      const matchesQuery = !query ||
        template.name.toLowerCase().includes(query) ||
        template.description.toLowerCase().includes(query) ||
        template.category.toLowerCase().includes(query);
      const matchesCategory = !category || template.category === category;
      return matchesQuery && matchesCategory;
    });
  }, [category, search, templates]);

  const handleInstall = async (templateId: string) => {
    const installed = installedAgentsByTemplate[templateId];
    if (installed) {
      goToTeamAgent(installed.id);
      return;
    }

    setInstalling(templateId);
    setFeedback(null);
    try {
      const res = await fetch(`/api/org/templates/${templateId}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui(`模板安装失败（${res.status}）`, `Template install failed (${res.status})`));
      void loadTemplates();
      void loadInstalledAgents();
      const agentId = data.agent?.id ? String(data.agent.id) : '';
      if (agentId) {
        setInstalledAgentsByTemplate(prev => ({
          ...prev,
          [templateId]: { id: agentId, name: String(data.agent?.name || data.template?.name || selected?.name || ui('团队智能体', 'Team agent')) },
        }));
      }
      window.dispatchEvent(new CustomEvent('peppa:agents-changed', { detail: { agent: data.agent, agentId } }));
      const agentName = data.agent?.name || data.template?.name || selected?.name || ui('智能体', 'Agent');
      setFeedback({
        type: 'success',
        text: data.alreadyInstalled
          ? ui(`已安装过，团队里已有：${agentName}`, `Already installed in Team: ${agentName}`)
          : ui(`已安装到 Peppa 团队：${agentName}`, `Installed to Peppa Team: ${agentName}`),
        agentId,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setInstalling(null);
    }
  };

  const goToTeamAgent = (agentId?: string) => {
    if (agentId) {
      try { window.sessionStorage.setItem('peppa:team:selected-agent-id', agentId); } catch {}
    }
    window.dispatchEvent(new CustomEvent('peppa:navigate', { detail: { tab: 'team', agentId } }));
    if (agentId) {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('peppa:team:select-agent', { detail: { agentId } }));
      }, 80);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-violet-400/20 bg-violet-500/10 text-violet-300">
                <Package size={22} />
              </span>
              <div>
                <h2 className="text-xl font-semibold text-white">{t.templateMarketplace || ui('智能体模板市场', 'Agent Template Marketplace')}</h2>
                <p className="mt-1 text-sm text-white/50">
                  {t.templateMarketplaceDesc || ui('把组织审核通过的子 agent 安装到 Peppa 团队。', 'Install organization-approved sub-agents into Peppa Team.')}
                </p>
              </div>
            </div>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('peppa:navigate', { detail: { tab: 'org', sub: 'templates-create' } }))}
              className="inline-flex items-center gap-2 rounded-lg border border-violet-400/20 bg-violet-500/15 px-3 py-2 text-sm font-medium text-violet-100 transition hover:bg-violet-500/25"
            >
              <Send size={15} />
              {t.submitTemplate || ui('提交智能体模板', 'Submit Agent Template')}
            </button>
          </div>
        </section>

        {feedback && <FeedbackBanner feedback={feedback} goToTeamLabel={ui('去团队查看', 'View in Team')} onGoToTeam={goToTeamAgent} />}

        <section className="grid gap-3 md:grid-cols-[1fr_220px]">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/45" />
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t.searchTemplates || ui('搜索模板...', 'Search templates...')}
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-2 pl-9 pr-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-violet-400/35"
            />
          </div>
          <select
            value={category}
            onChange={event => setCategory(event.target.value)}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/75 outline-none focus:border-violet-400/35"
          >
            <option value="">{t.allCategoriesFilter || ui('全部分类', 'All Categories')}</option>
            {categories.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </section>

        {loading ? (
          <div className="flex h-64 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/55">
            <Loader2 size={24} className="animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] text-center text-sm text-white/45">
            <Package size={32} className="text-white/20" />
            <span>{t.noTemplatesFound || ui('未找到模板', 'No templates found')}</span>
          </div>
        ) : (
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map(template => {
              const installed = installedAgentsByTemplate[template.id];
              return (
              <motion.button
                key={template.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                onClick={() => setSelected(template)}
                className="rounded-lg border border-white/10 bg-white/[0.04] p-4 text-left transition hover:border-violet-400/25 hover:bg-white/[0.07]"
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-sm text-white/75">
                    {template.icon || 'Bot'}
                  </span>
                  <span className={`rounded-md px-2 py-1 text-xs ${installed ? 'bg-emerald-500/10 text-emerald-200' : 'bg-violet-500/10 text-violet-200'}`}>
                    {installed ? ui('已在团队', 'In Team') : `v${template.version}`}
                  </span>
                </div>
                <h3 className="truncate text-sm font-medium text-white">{template.name}</h3>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-white/45">{template.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-white/45">
                  <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1">
                    <Tag size={10} />
                    {template.category}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1">
                    <Download size={10} />
                    {template.downloadCount || 0}
                  </span>
                  {installed && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-emerald-200">
                      <Bot size={10} />
                      {installed.name}
                    </span>
                  )}
                </div>
              </motion.button>
              );
            })}
          </section>
        )}

        <AnimatePresence>
          {selected && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
              onClick={() => setSelected(null)}
            >
              <motion.div
                initial={{ scale: 0.96, y: 12 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.96, y: 12 }}
                onClick={event => event.stopPropagation()}
                className="w-full max-w-lg rounded-lg border border-white/10 bg-zinc-950 p-5 shadow-2xl"
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-sm text-white/75">
                      {selected.icon || 'Bot'}
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold text-white">{selected.name}</h3>
                      <p className="mt-1 text-sm leading-6 text-white/55">{selected.description}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelected(null)}
                    className="rounded-lg p-2 text-white/45 hover:bg-white/10 hover:text-white"
                  >
                    <X size={17} />
                  </button>
                </div>

                <div className="mb-5 flex flex-wrap gap-2 text-xs text-white/45">
                  <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1">
                    <Tag size={11} />
                    {selected.category}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1">
                    <Download size={11} />
                    {selected.downloadCount || 0} {t.numInstalls || ui('次安装', 'installs')}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1">
                    <Clock size={11} />
                    v{selected.version}
                  </span>
                </div>

                {(() => {
                  const installed = installedAgentsByTemplate[selected.id];
                  return (
                <button
                  onClick={() => installed ? goToTeamAgent(installed.id) : handleInstall(selected.id)}
                  disabled={installing === selected.id}
                  className={`inline-flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium transition disabled:opacity-50 ${
                    installed
                      ? 'border-emerald-400/20 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25'
                      : 'border-violet-400/20 bg-violet-500/15 text-violet-100 hover:bg-violet-500/25'
                  }`}
                >
                  {installing === selected.id ? <Loader2 size={16} className="animate-spin" /> : installed ? <Bot size={16} /> : <Download size={16} />}
                  {installing === selected.id
                    ? (t.installingTemplate || ui('安装中...', 'Installing...'))
                    : installed
                      ? ui('查看团队智能体', 'View Team Agent')
                      : ui('安装为团队智能体', 'Install as Team Agent')}
                </button>
                  );
                })()}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function FeedbackBanner({ feedback, goToTeamLabel, onGoToTeam }: { feedback: Feedback; goToTeamLabel: string; onGoToTeam: (agentId?: string) => void }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
      feedback.type === 'success'
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
        : 'border-red-500/20 bg-red-500/10 text-red-200'
    }`}>
      <span className="flex min-w-0 items-start gap-2">
        {feedback.type === 'success' ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
        <span>{feedback.text}</span>
      </span>
      {feedback.type === 'success' && (
        <button
          onClick={() => onGoToTeam(feedback.agentId)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-300/20 bg-emerald-400/10 px-2.5 py-1.5 text-xs font-medium text-emerald-100 transition hover:bg-emerald-400/20"
        >
          <Bot size={13} />
          {goToTeamLabel}
        </button>
      )}
    </div>
  );
}
