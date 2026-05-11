import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, Search, Sparkles, TrendingUp, Network, GitMerge, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useSocket } from '@/hooks/useSocket';
import { NodeDetailPanel } from './NodeDetailPanel';
import { MemoryTreeScene, TimelineTransitionController, layoutTree3D, useMemoryFilter } from './MemoryTree';
import type { TreeNode3D, BranchCurve3D, TimelineState, MemoryNode as MemNode, FileEntry } from './MemoryTree';

interface MemoryTree { node: MemNode; children: MemoryTree[]; }

interface KnowledgeBaseProps {
  t?: any;
  isOpen: boolean;
  onClose: () => void;
}

export function KnowledgeBase({ t, isOpen, onClose }: KnowledgeBaseProps) {
  const socket = useSocket();

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [memories, setMemories] = useState<MemNode[]>([]);
  const [treeNodes, setTreeNodes] = useState<TreeNode3D[]>([]);
  const [branchCurves, setBranchCurves] = useState<BranchCurve3D[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [reflecting, setReflecting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [timeline, setTimeline] = useState<TimelineState>({
    before: null,
    playing: false,
    speed: 1,
    earliest: null,
    latest: null,
  });

  // Fetch data
  const fetchAll = useCallback(async (before?: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/files/list');
      if (res.ok) {
        const d = await res.json();
        setFiles(d.files || []);
      }
    } catch (err) { console.warn('[KnowledgeBase] files fetch failed:', err); }

    try {
      const params = new URLSearchParams();
      if (before) params.set('before', before);
      const qs = params.toString();
      const res = await fetch(`/api/memory/tree${qs ? `?${qs}` : ''}`);
      if (res.ok) {
        const d = await res.json();
        const flat: MemNode[] = [];
        const walk = (nodes: MemoryTree[]) => {
          for (const n of nodes) { flat.push(n.node); walk(n.children); }
        };
        walk(d.tree || []);
        setMemories(flat);
      }
    } catch (err) { console.warn('[KnowledgeBase] memories fetch failed:', err); }

    setLoading(false);
  }, []);

  useEffect(() => { if (isOpen) fetchAll(timeline.before ?? undefined); }, [isOpen, fetchAll, timeline.before]);

  // Socket
  useEffect(() => {
    if (!socket || !isOpen) return;
    const handler = () => fetchAll(timeline.before ?? undefined);
    socket.on('memories:changed', handler);
    return () => { socket.off('memories:changed', handler); };
  }, [socket, isOpen, fetchAll, timeline.before]);

  // Build tree
  useEffect(() => {
    if (!isOpen) return;
    const { nodes, curves } = layoutTree3D(memories, files);
    setTreeNodes(nodes);
    setBranchCurves(curves);

    // Compute earliest/latest dates from memories
    const memsWithDates = memories.filter(m => m.nodeType !== 'branch' && m.createdAt);
    if (memsWithDates.length > 0) {
      const earliest = memsWithDates.reduce((a, b) =>
        new Date(a.createdAt!).getTime() < new Date(b.createdAt!).getTime() ? a : b
      );
      const latest = memsWithDates.reduce((a, b) =>
        new Date(a.createdAt!).getTime() > new Date(b.createdAt!).getTime() ? a : b
      );
      setTimeline(prev => ({
        ...prev,
        earliest: earliest.createdAt!,
        latest: latest.createdAt!,
      }));
    }
  }, [memories, files, isOpen]);

  // Find selected node data
  const selectedNode = selectedId ? treeNodes.find(n => n.id === selectedId) : null;
  const selectedFileData = selectedId ? files.find(f => f.id === selectedId) : undefined;
  const selectedMemoryData = selectedId ? memories.find(m => m.id === selectedId) : undefined;

  // Filtered data for rendering (timeline only; search dimming in scene)
  const filtered = useMemoryFilter(treeNodes, branchCurves, timeline);

  // Actions
  const handleDelete = async (id: string) => {
    const n = treeNodes.find(nd => nd.id === id);
    if (!n || !confirm(`Delete "${n.title}"?`)) return;
    try {
      const endpoint = n.type === 'file' ? `/api/files/delete/${encodeURIComponent(id)}` : `/api/memories/${id}`;
      const res = await fetch(endpoint, { method: 'DELETE' });
      if (res.ok) { toast.success('Deleted'); fetchAll(); setSelectedId(null); }
      else toast.error('Delete failed');
    } catch { toast.error('Delete failed'); }
  };

  const handleDownload = async (id: string) => {
    try {
      const res = await fetch(`/api/files/download/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = id;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch { toast.error('Download failed'); }
  };

  const handleIngest = async (id: string) => {
    const agentId = prompt('Enter agent ID:');
    if (!agentId) return;
    try {
      const res = await fetch('/api/files/ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: id, agentId }),
      });
      if (res.ok) { toast.success('Ingested'); fetchAll(); }
      else toast.error('Ingest failed');
    } catch { toast.error('Ingest failed'); }
  };

  const handleToggleProtect = async (id: string) => {
    try {
      const res = await fetch(`/api/memory/${id}/protect`, { method: 'PUT' });
      const d = await res.json();
      toast.success(d.protected ? 'Protected' : 'Unprotected');
      fetchAll();
    } catch { toast.error('Protect failed'); }
  };

  const handleChangeTier = async (id: string, tier: string, confirmed = false) => {
    try {
      const res = await fetch(`/api/memory/${id}/tier`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, confirmed }),
      });
      if (!res.ok) {
        const d = await res.json();
        if (d.error?.includes('confirmed')) {
          if (confirm('Promote to Core Identity?')) return handleChangeTier(id, tier, true);
          return;
        }
        throw new Error(d.error);
      }
      toast.success('Tier changed'); fetchAll();
    } catch (err: any) { toast.error(err.message); }
  };

  const handleEdit = async (id: string, content: string) => {
    try {
      const res = await fetch(`/api/memories/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) { toast.success('Updated'); fetchAll(); }
      else toast.error('Update failed');
    } catch { toast.error('Update failed'); }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      for (let i = 0; i < files.length; i++) formData.append('files', files[i]);
      const res = await fetch('/api/files/upload', { method: 'POST', body: formData, credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        toast.success(`Uploaded ${d.files?.length || files.length} file(s)`);
        fetchAll();
      } else toast.error('Upload failed');
    } catch { toast.error('Upload failed'); }
    finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleAutoOrganize = async () => {
    setOrganizing(true);
    try {
      const res = await fetch('/api/memory/auto-organize', { method: 'POST' });
      const d = await res.json();
      if (d.success) { toast.success(`Organized: ${d.branchesCreated} branches, ${d.memoriesAssigned} memories`); fetchAll(); }
      else toast.info(d.reason || 'Not enough unorganized memories');
    } catch { toast.error('Organization failed'); }
    finally { setOrganizing(false); }
  };

  const handleConsolidate = async () => {
    setConsolidating(true);
    try {
      const res = await fetch('/api/memory/consolidate', { method: 'POST' });
      const d = await res.json();
      if (d.success) { toast.success('Consolidated'); fetchAll(); }
      else toast.info(d.reason || `Need ${d.threshold || 10} memories`);
    } catch { toast.error('Consolidation failed'); }
    finally { setConsolidating(false); }
  };

  const handleSelfReflect = async () => {
    setReflecting(true);
    try {
      const res = await fetch('/api/memory/self-reflect', { method: 'POST' });
      const d = await res.json();
      if (d.success) { toast.success('Reflection complete'); fetchAll(); }
      else toast.info(d.reason || 'Nothing to reflect on');
    } catch { toast.error('Reflection failed'); }
    finally { setReflecting(false); }
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch('/api/memory/analyze-behavior', { method: 'POST' });
      const d = await res.json();
      if (d.patternsFound > 0) { toast.success(`Found ${d.patternsFound} patterns`); fetchAll(); }
      else toast.info('No new patterns');
    } catch { toast.error('Analysis failed'); }
    finally { setAnalyzing(false); }
  };

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && isOpen && !selectedId) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, selectedId]);

  const totalFiles = files.length;
  const totalMemories = memories.filter(m => m.nodeType !== 'branch').length;
  const totalBranches = memories.filter(m => m.nodeType === 'branch').length;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ clipPath: 'circle(0% at 50% 95%)', opacity: 0 }}
          animate={{ clipPath: 'circle(150% at 50% 95%)', opacity: 1 }}
          exit={{ clipPath: 'circle(0% at 50% 95%)', opacity: 0 }}
          transition={{ duration: 0.75, ease: [0.25, 0.1, 0.25, 1] }}
          className="fixed inset-0 z-[200]"
          style={{
            background: 'radial-gradient(ellipse at 50% 30%, #0f0f23 0%, #080812 40%, #020205 100%)',
          }}
        >
          {/* 3D Memory Tree Scene */}
          <MemoryTreeScene
            nodes={filtered.nodes}
            curves={filtered.curves}
            searchQuery={search}
            highlightedNodeId={selectedId}
            onNodeClick={(id, sx, sy) => {
              if (!id) { setSelectedId(null); setCardPos(null); return; }
              setSelectedId(prev => prev === id ? null : id);
              setCardPos(prev => prev ? null : { x: sx, y: sy });
            }}
            onNodeDoubleClick={(id) => setSelectedId(id)}
          />

          {/* Loading overlay */}
          <AnimatePresence>
            {loading && (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 flex items-center justify-center bg-black/40 z-10"
              >
                <div className="flex flex-col items-center gap-4">
                  <Loader2 size={40} className="animate-spin text-amber-400" />
                  <span className="text-[11px] font-black uppercase tracking-[0.3em] text-white/30">Awakening...</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Top bar — controls */}
          <div className="absolute top-6 left-6 right-6 z-20 pointer-events-none">
            <div className="flex items-center gap-3 justify-between pointer-events-auto">
              {/* Left: title */}
              <div className="flex items-center gap-3 bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2">
                <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.5)]" />
                <span className="text-[10px] font-black text-white/50 uppercase tracking-[0.2em]">智库</span>
              </div>

              {/* Search */}
              <div className="flex items-center gap-2 bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2 flex-1 max-w-[280px]">
                <Search size={13} className="text-white/20 shrink-0" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search nodes..."
                  className="bg-transparent text-[11px] text-white/70 placeholder:text-white/20 outline-none flex-1 min-w-0"
                />
              </div>

              {/* Center: actions */}
              <div className="flex items-center gap-2">
                {/* Hidden file input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleUpload}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-green-500/20 rounded-xl px-3 py-2 text-[10px] font-bold text-green-400/70 hover:text-green-300 hover:border-green-400/40 transition-all"
                >
                  {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                  Import
                </button>
                <button
                  onClick={handleAutoOrganize}
                  disabled={organizing}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-cyan-500/20 rounded-xl px-3 py-2 text-[10px] font-bold text-cyan-400/70 hover:text-cyan-300 hover:border-cyan-400/40 transition-all"
                >
                  {organizing ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />}
                  Organize
                </button>
                <button
                  onClick={handleConsolidate}
                  disabled={consolidating}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-emerald-500/20 rounded-xl px-3 py-2 text-[10px] font-bold text-emerald-400/70 hover:text-emerald-300 hover:border-emerald-400/40 transition-all"
                >
                  {consolidating ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}
                  Merge
                </button>
                <button
                  onClick={handleSelfReflect}
                  disabled={reflecting}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-violet-500/20 rounded-xl px-3 py-2 text-[10px] font-bold text-violet-400/70 hover:text-violet-300 hover:border-violet-400/40 transition-all"
                >
                  {reflecting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  Reflect
                </button>
                <button
                  onClick={handleAnalyze}
                  disabled={analyzing}
                  className="flex items-center gap-1.5 bg-black/40 backdrop-blur-xl border border-amber-500/20 rounded-xl px-3 py-2 text-[10px] font-bold text-amber-400/70 hover:text-amber-300 hover:border-amber-400/40 transition-all"
                >
                  {analyzing ? <Loader2 size={13} className="animate-spin" /> : <TrendingUp size={13} />}
                  Patterns
                </button>
              </div>

              {/* Right: close + stats */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-3 bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2">
                  <span className="text-[9px] font-bold text-blue-400/60">{totalFiles} files</span>
                  <span className="w-px h-3 bg-white/[0.08]" />
                  <span className="text-[9px] font-bold text-amber-400/60">{totalMemories} mem</span>
                  <span className="w-px h-3 bg-white/[0.08]" />
                  <span className="text-[9px] font-bold text-cyan-400/60">{totalBranches} branches</span>
                </div>
                <button
                  onClick={onClose}
                  className="w-10 h-10 flex items-center justify-center bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl text-white/40 hover:text-white hover:border-white/20 transition-all"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
          </div>

          {/* Floating detail card */}
          <NodeDetailPanel
            node={selectedNode ? {
              id: selectedNode.id,
              type: selectedNode.type as 'file' | 'memory' | 'branch',
              title: selectedNode.title,
              hue: selectedNode.hue,
              fileData: selectedFileData,
              memoryData: selectedMemoryData,
              isCore: selectedNode.tier === 'core_identity',
              isBranch: selectedNode.type === 'branch',
            } : null}
            position={cardPos}
            onClose={() => { setSelectedId(null); setCardPos(null); }}
            onDelete={handleDelete}
            onDownload={handleDownload}
            onIngest={handleIngest}
            onToggleProtect={handleToggleProtect}
            onChangeTier={handleChangeTier}
            onEdit={handleEdit}
          />

          {/* Timeline controller */}
          <TimelineTransitionController
            timeline={timeline}
            onChangeTimeline={setTimeline}
            earliestDate={timeline.earliest}
            latestDate={timeline.latest}
          />

          {/* Bottom hint */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <span className="text-[9px] font-bold text-white/15 uppercase tracking-[0.15em] bg-black/30 px-4 py-1.5 rounded-full border border-white/[0.04]">
              ESC to close · Click nodes to inspect · Drag to rotate
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export { layoutTree3D };
