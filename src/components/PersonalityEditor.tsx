import React, { useState, useEffect } from 'react';
import { User, Plus, Trash2, Save, X, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';

interface PersonalityConfig {
  id: string;
  name: string;
  version: string;
  coreMotivation: string;
  behavioralBoundaries: string[];
  expressionStyle: {
    persona: string;
    tone: 'neutral' | 'warm' | 'professional' | 'technical' | 'playful' | 'inspiring';
    verbosity: 'concise' | 'balanced' | 'detailed';
    languages: string[];
    vocabularyHints?: string[];
  };
  toolPolicy: {
    allowedTools: string[];
    requireConfirmation: string[];
    forbiddenTools: string[];
    maxIterations: number;
    securityOverrides?: Record<string, string>;
  };
  memoryPolicy: {
    retrieveLimit: number;
    minConfidence: number;
    includeTypes: string[];
    autoExtract: boolean;
  };
  defaultModel: string;
  fallbackModel: string;
}

const DEFAULT_CONFIG: PersonalityConfig = {
  id: '',
  name: '',
  version: '1.0',
  coreMotivation: '',
  behavioralBoundaries: [],
  expressionStyle: {
    persona: '',
    tone: 'neutral',
    verbosity: 'balanced',
    languages: ['en'],
    vocabularyHints: [],
  },
  toolPolicy: {
    allowedTools: ['*'],
    requireConfirmation: [],
    forbiddenTools: [],
    maxIterations: 3,
    securityOverrides: {},
  },
  memoryPolicy: {
    retrieveLimit: 5,
    minConfidence: 0.4,
    includeTypes: ['preference', 'fact'],
    autoExtract: true,
  },
  defaultModel: 'qwen-plus',
  fallbackModel: 'gemini-1.5-flash',
};

const TONES = ['neutral', 'warm', 'professional', 'technical', 'playful', 'inspiring'] as const;
const VERBOSITIES = ['concise', 'balanced', 'detailed'] as const;
const MEMORY_TYPES = ['preference', 'fact', 'habit', 'knowledge'] as const;

export function PersonalityEditor({ t }: { t?: any }) {
  const [personalities, setPersonalities] = useState<PersonalityConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonalityConfig>(DEFAULT_CONFIG);
  const [isNew, setIsNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState<any[]>([]);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    identity: true,
    boundaries: true,
    expression: true,
    tools: false,
    memory: false,
    models: false,
  });

  const toggleSection = (s: string) => setExpandedSections(prev => ({ ...prev, [s]: !prev[s] }));

  const fetchPersonalities = async () => {
    try {
      const res = await fetch('/api/personalities');
      const data = await res.json();
      setPersonalities(data);
    } finally {
      setLoading(false);
    }
  };

  const fetchFullConfig = async (id: string) => {
    try {
      const res = await fetch(`/api/personalities/${id}`);
      const data = await res.json();
      setEditing(data);
      setIsNew(false);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  useEffect(() => { fetchPersonalities(); fetch('/api/tools').then(r => r.json()).then(setTools).catch(err => toast.error('Failed to load tools')); }, []);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    fetchFullConfig(id);
  };

  const handleNew = () => {
    setSelectedId(null);
    setEditing({ ...DEFAULT_CONFIG, id: 'custom_' + Date.now() });
    setIsNew(true);
  };

  const handleSave = async () => {
    if (!editing.id || !editing.name) {
      toast.error('ID and Name are required');
      return;
    }
    try {
      const res = await fetch('/api/personalities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      toast.success(`${editing.name} saved`);
      await fetchPersonalities();
      setSelectedId(editing.id);
      setIsNew(false);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (id === 'lumi') { toast.error("Cannot delete 'lumi'"); return; }
    try {
      await fetch(`/api/personalities/${id}`, { method: 'DELETE' });
      toast.success('Personality deleted');
      setSelectedId(null);
      setEditing(DEFAULT_CONFIG);
      fetchPersonalities();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const update = (path: string[], value: any) => {
    setEditing(prev => {
      const next = { ...prev };
      let obj: any = next;
      for (let i = 0; i < path.length - 1; i++) {
        obj = obj[path[i]];
      }
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  const addBoundary = () => update(['behavioralBoundaries'], [...editing.behavioralBoundaries, '']);
  const removeBoundary = (i: number) => update(['behavioralBoundaries'], editing.behavioralBoundaries.filter((_, idx) => idx !== i));

  const addVocab = () => update(['expressionStyle', 'vocabularyHints'], [...(editing.expressionStyle.vocabularyHints || []), '']);
  const removeVocab = (i: number) => update(['expressionStyle', 'vocabularyHints'], (editing.expressionStyle.vocabularyHints || []).filter((_, idx) => idx !== i));

  if (loading) {
    return (
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="flex items-center gap-3">
          <User className="text-celestial-saturn" />
          <h3 className="text-xl font-bold uppercase tracking-tighter text-white/90">Personality Editor</h3>
        </div>
        <p className="text-white/40 text-sm">Loading personality configurations...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <User className="text-celestial-saturn" />
          <h3 className="text-xl font-bold uppercase tracking-tighter text-white/90">Personality Editor</h3>
        </div>
        <Button onClick={handleNew} className="bg-celestial-saturn text-black font-bold text-xs px-4 py-2 rounded-xl">
          <Plus size={14} className="mr-1" /> New
        </Button>
      </div>

      <p className="text-sm text-white/40 max-w-xl">
        Define AI personalities with structured identity, boundaries, expression style, and tool policies.
        Each personality can be used as-is or overridden per context.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Personality list */}
        <div className="space-y-2">
          <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-2">Personalities</label>
          {personalities.map(p => (
            <button
              key={p.id}
              onClick={() => handleSelect(p.id)}
              className={`w-full text-left p-4 rounded-2xl border transition-all ${
                selectedId === p.id
                  ? 'bg-celestial-saturn/10 border-celestial-saturn/30 text-white'
                  : 'bg-white/5 border-white/5 text-white/60 hover:bg-white/10'
              }`}
            >
              <div className="font-bold text-sm">{p.name}</div>
              <div className="text-[10px] text-white/30 mt-1 truncate">{p.coreMotivation?.slice(0, 50)}</div>
            </button>
          ))}
          {personalities.length === 0 && (
            <p className="text-white/20 text-xs p-4">No personalities defined.</p>
          )}
        </div>

        {/* Editor */}
        {selectedId || isNew ? (
          <div className="lg:col-span-2 space-y-4">
            {/* Identity */}
            <Section title="Identity" section="identity" expanded={expandedSections} onToggle={toggleSection}>
              <Field label="ID" value={editing.id} onChange={v => update(['id'], v)} disabled={!isNew} mono />
              <Field label="Name" value={editing.name} onChange={v => update(['name'], v)} />
              <Field label="Version" value={editing.version} onChange={v => update(['version'], v)} />
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase text-white/30">Core Motivation</label>
                <textarea
                  value={editing.coreMotivation}
                  onChange={e => update(['coreMotivation'], e.target.value)}
                  rows={3}
                  className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm font-mono focus:border-celestial-saturn/50 outline-none resize-none"
                />
              </div>
            </Section>

            {/* Boundaries */}
            <Section title="Behavioral Boundaries" section="boundaries" expanded={expandedSections} onToggle={toggleSection}>
              {editing.behavioralBoundaries.map((b, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={b}
                    onChange={e => {
                      const next = [...editing.behavioralBoundaries];
                      next[i] = e.target.value;
                      update(['behavioralBoundaries'], next);
                    }}
                    placeholder="e.g. Do not pretend to be human"
                    className="flex-1 bg-white/5 border-white/10 rounded-xl py-2 text-sm"
                  />
                  <button onClick={() => removeBoundary(i)} className="p-2 text-white/20 hover:text-red-500">
                    <X size={14} />
                  </button>
                </div>
              ))}
              <Button onClick={addBoundary} variant="ghost" className="text-xs text-white/30">
                <Plus size={12} className="mr-1" /> Add boundary
              </Button>
            </Section>

            {/* Expression Style */}
            <Section title="Expression Style" section="expression" expanded={expandedSections} onToggle={toggleSection}>
              <Field label="Persona" value={editing.expressionStyle.persona} onChange={v => update(['expressionStyle', 'persona'], v)} placeholder="a futuristic AI architect" />

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase text-white/30">Tone</label>
                  <select
                    value={editing.expressionStyle.tone}
                    onChange={e => update(['expressionStyle', 'tone'], e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm font-bold appearance-none cursor-pointer"
                  >
                    {TONES.map(t => (<option key={t} value={t}>{t}</option>))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase text-white/30">Verbosity</label>
                  <select
                    value={editing.expressionStyle.verbosity}
                    onChange={e => update(['expressionStyle', 'verbosity'], e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm font-bold appearance-none cursor-pointer"
                  >
                    {VERBOSITIES.map(v => (<option key={v} value={v}>{v}</option>))}
                  </select>
                </div>
              </div>

              <Field label="Languages (comma separated)" value={editing.expressionStyle.languages.join(', ')} onChange={v => update(['expressionStyle', 'languages'], v.split(',').map(s => s.trim()).filter(Boolean))} mono />

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase text-white/30">Vocabulary Hints</label>
                {(editing.expressionStyle.vocabularyHints || []).map((h, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input value={h} onChange={e => {
                      const next = [...(editing.expressionStyle.vocabularyHints || [])];
                      next[i] = e.target.value;
                      update(['expressionStyle', 'vocabularyHints'], next);
                    }} className="flex-1 bg-white/5 border-white/10 rounded-xl py-2 text-sm" />
                    <button onClick={() => removeVocab(i)} className="p-2 text-white/20 hover:text-red-500"><X size={14} /></button>
                  </div>
                ))}
                <Button onClick={addVocab} variant="ghost" className="text-xs text-white/30"><Plus size={12} className="mr-1" /> Add hint</Button>
              </div>
            </Section>

            {/* Tool Policy */}
            <Section title="Tool Policy" section="tools" expanded={expandedSections} onToggle={toggleSection}>
              <Field label="Allowed Tools (comma separated, * for all)" value={(editing.toolPolicy.allowedTools || ['*']).join(', ')} onChange={v => update(['toolPolicy', 'allowedTools'], v.split(',').map(s => s.trim()).filter(Boolean))} />
              <Field label="Require Confirmation (comma separated)" value={(editing.toolPolicy.requireConfirmation || []).join(', ')} onChange={v => update(['toolPolicy', 'requireConfirmation'], v.split(',').map(s => s.trim()).filter(Boolean))} />
              <Field label="Forbidden Tools (comma separated)" value={(editing.toolPolicy.forbiddenTools || []).join(', ')} onChange={v => update(['toolPolicy', 'forbiddenTools'], v.split(',').map(s => s.trim()).filter(Boolean))} />
              <Field label="Max Iterations" value={String(editing.toolPolicy.maxIterations)} onChange={v => update(['toolPolicy', 'maxIterations'], parseInt(v) || 3)} type="number" />

              {/* Per-tool security overrides */}
              {tools.length > 0 && (
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase text-white/30">Per-Tool Security Overrides</label>
                  <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
                    {tools.map(tool => {
                      const currentOverride = (editing.toolPolicy.securityOverrides || {})[tool.name] || tool.securityLevel;
                      const isOverridden = currentOverride !== tool.securityLevel;
                      return (
                        <div key={tool.name} className="flex items-center gap-2 p-2 bg-white/5 rounded-xl group hover:bg-white/10 transition-all">
                          <div className="flex-1 min-w-0">
                            <span className="text-[10px] font-mono text-white/70 block truncate">{tool.name}</span>
                            <span className="text-[8px] text-white/20">{tool.description}</span>
                          </div>
                          <select
                            value={currentOverride}
                            onChange={e => {
                              const overrides = { ...(editing.toolPolicy.securityOverrides || {}) };
                              if (e.target.value === tool.securityLevel) {
                                delete overrides[tool.name];
                              } else {
                                overrides[tool.name] = e.target.value;
                              }
                              update(['toolPolicy', 'securityOverrides'], overrides);
                            }}
                            className={`text-[9px] font-bold uppercase px-2 py-1 rounded-lg border appearance-none cursor-pointer outline-none ${
                              isOverridden ? 'bg-celestial-saturn/20 text-celestial-saturn border-celestial-saturn/30' : 'bg-white/5 text-white/30 border-white/5'
                            }`}
                          >
                            <option value="safe">Safe</option>
                            <option value="confirm">Confirm</option>
                            <option value="forbidden">Forbidden</option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Section>

            {/* Memory Policy */}
            <Section title="Memory Policy" section="memory" expanded={expandedSections} onToggle={toggleSection}>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Retrieve Limit" value={String(editing.memoryPolicy.retrieveLimit)} onChange={v => update(['memoryPolicy', 'retrieveLimit'], parseInt(v) || 5)} type="number" />
                <Field label="Min Confidence" value={String(editing.memoryPolicy.minConfidence)} onChange={v => update(['memoryPolicy', 'minConfidence'], parseFloat(v) || 0.4)} type="number" step="0.1" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase text-white/30">Include Types</label>
                <div className="flex flex-wrap gap-2">
                  {MEMORY_TYPES.map(mt => (
                    <button
                      key={mt}
                      onClick={() => {
                        const cur = editing.memoryPolicy.includeTypes;
                        update(['memoryPolicy', 'includeTypes'], cur.includes(mt) ? cur.filter(t => t !== mt) : [...cur, mt]);
                      }}
                      className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase transition-all ${
                        editing.memoryPolicy.includeTypes.includes(mt) ? 'bg-celestial-saturn/20 text-celestial-saturn border border-celestial-saturn/30' : 'bg-white/5 text-white/30 border border-white/5'
                      }`}
                    >
                      {mt}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer">
                <input type="checkbox" checked={editing.memoryPolicy.autoExtract} onChange={e => update(['memoryPolicy', 'autoExtract'], e.target.checked)} className="rounded" />
                Auto-extract from conversations
              </label>
            </Section>

            {/* Models */}
            <Section title="Models" section="models" expanded={expandedSections} onToggle={toggleSection}>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Default Model" value={editing.defaultModel} onChange={v => update(['defaultModel'], v)} placeholder="qwen-plus" />
                <Field label="Fallback Model" value={editing.fallbackModel} onChange={v => update(['fallbackModel'], v)} placeholder="gemini-1.5-flash" />
              </div>
            </Section>

            {/* Actions */}
            <div className="flex justify-between pt-4">
              <Button
                onClick={() => handleDelete(editing.id)}
                variant="ghost"
                className="text-red-500/50 hover:text-red-500 text-xs px-4 py-2"
                disabled={editing.id === 'lumi'}
              >
                <Trash2 size={14} className="mr-1" /> Delete
              </Button>
              <Button onClick={handleSave} className="bg-celestial-saturn text-black font-bold px-8 py-3 rounded-xl">
                <Save size={14} className="mr-1" /> Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="lg:col-span-2 flex items-center justify-center p-16 bg-white/5 rounded-[2rem] border border-white/5">
            <p className="text-white/20 text-sm uppercase tracking-widest">Select a personality or create a new one</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Sub-components

function Section({ title, section, expanded, onToggle, children }: {
  title: string;
  section: string;
  expanded: Record<string, boolean>;
  onToggle: (s: string) => void;
  children: React.ReactNode;
}) {
  const open = expanded[section] !== false;
  return (
    <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
      <button onClick={() => onToggle(section)} className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white/50 hover:text-white/80 w-full text-left">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && <div className="space-y-3">{children}</div>}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, disabled, mono, type, step }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  type?: string;
  step?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] font-black uppercase text-white/30">{label}</label>
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        type={type}
        step={step}
        className={`w-full bg-white/5 border-white/10 rounded-xl py-2 text-sm ${mono ? 'font-mono' : ''} ${disabled ? 'opacity-50' : ''}`}
      />
    </div>
  );
}
