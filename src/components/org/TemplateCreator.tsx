import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Package, Send, Loader2, ArrowLeft } from 'lucide-react';
import { Button } from '../ui/button';
import { useT } from '../../lib/useT';

export function TemplateCreator() {
  const t = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('productivity');
  const [icon, setIcon] = useState('Bot');
  const [configStr, setConfigStr] = useState(JSON.stringify({
    initialPrompt: '',
    personalityId: 'lumi',
    allowedTools: '*',
    memoryPolicy: { retrieveLimit: 10, autoExtract: true },
  }, null, 2));
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim() || !description.trim()) return;
    setSubmitting(true);
    try {
      let config: any;
      try { config = JSON.parse(configStr); } catch { config = {}; }

      const res = await fetch('/api/org/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, category, config, icon }),
        credentials: 'include',
      });

      if (res.ok) {
        const t = await res.json();
        // Submit for review immediately
        await fetch(`/api/org/templates/${t.id}/submit`, {
          method: 'POST',
          credentials: 'include',
        });
        setDone(true);
      }
    } catch {} finally { setSubmitting(false); }
  };

  if (done) {
    return (
      <div className="p-6 text-center space-y-4">
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }}>
          <Send size={48} className="mx-auto text-green-400" />
        </motion.div>
        <h3 className="text-xl font-bold text-white">{t.templateSubmitted || 'Template Submitted!'}</h3>
        <p className="text-white/40 text-sm">{t.templatePendingReview || 'Your template is pending review by an admin.'}</p>
        <Button
          onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'templates' } }))}
          className="bg-white/10 hover:bg-white/20 text-white rounded-lg"
        >
          <ArrowLeft size={16} className="mr-1" /> {t.backToMarketplace || 'Back to Marketplace'}
        </Button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-2">
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'templates' } }))}
          className="text-white/40 hover:text-white"
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <Package size={24} className="text-purple-400" />
          {t.submitTemplate || 'Submit a Template'}
        </h2>
      </div>
      <p className="text-white/40 text-sm">{t.templateDesc || 'Create a template from one of your agents to share with the organization'}</p>

      <div className="flex gap-3">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t.templateName || 'Template name'}
          className="flex-1 px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/45 focus:outline-none focus:border-purple-500/40"
        />
        <input
          value={icon}
          onChange={e => setIcon(e.target.value)}
          placeholder={t.iconLabel || 'Icon'}
          className="w-20 px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/45 focus:outline-none text-center"
        />
      </div>

      <input
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder={t.briefDescription || 'Brief description of what this agent does...'}
        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/45 focus:outline-none focus:border-purple-500/40"
      />

      <select
        value={category}
        onChange={e => setCategory(e.target.value)}
        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white/70 text-sm focus:outline-none"
      >
        <option value="productivity">{t.categoryProductivity || 'Productivity'}</option>
        <option value="data-analysis">{t.categoryDataAnalysis || 'Data Analysis'}</option>
        <option value="customer-support">{t.categoryCustomerSupport || 'Customer Support'}</option>
        <option value="engineering">{t.categoryEngineering || 'Engineering'}</option>
        <option value="hr">{t.categoryHR || 'HR'}</option>
        <option value="sales">{t.categorySales || 'Sales'}</option>
        <option value="creative">{t.categoryCreative || 'Creative'}</option>
        <option value="other">{t.categoryOther || 'Other'}</option>
      </select>

      <div>
        <p className="text-white/55 text-xs mb-2">{t.agentConfigJSON || 'Agent Configuration (JSON)'}</p>
        <textarea
          value={configStr}
          onChange={e => setConfigStr(e.target.value)}
          className="w-full h-48 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-xs placeholder:text-white/45 focus:outline-none focus:border-purple-500/40 resize-y font-mono"
        />
      </div>

      <Button
        onClick={handleSubmit}
        disabled={submitting || !name.trim() || !description.trim()}
        className="w-full bg-purple-600 hover:bg-purple-500 text-white rounded-xl py-3 flex items-center justify-center gap-2"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        {t.submitForReview || 'Submit for Review'}
      </Button>
    </div>
  );
}
