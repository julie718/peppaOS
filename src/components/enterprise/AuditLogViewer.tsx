import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import {
  ScrollText, Search, Download, Filter, Loader2, ChevronDown,
  Clock, User, Activity, FileText, X,
} from 'lucide-react';
import { Button } from '../ui/button';

interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details: string;
  timestamp: string;
}

export function AuditLogViewer() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ userId: '', action: '', resourceType: '' });
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    loadEntries();
  }, []);

  const loadEntries = useCallback(async (withFilters?: typeof filters) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (withFilters) {
        if (withFilters.userId) params.set('userId', withFilters.userId);
        if (withFilters.action) params.set('action', withFilters.action);
        if (withFilters.resourceType) params.set('resourceType', withFilters.resourceType);
      }
      const res = await fetch(`/api/enterprise/audit?${params.toString()}`, { credentials: 'include' });
      if (res.ok) setEntries(await res.json());
    } catch {} finally { setLoading(false); }
  }, []);

  const handleFilter = () => {
    loadEntries(filters);
  };

  const handleExport = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.userId) params.set('userId', filters.userId);
      if (filters.action) params.set('action', filters.action);
      if (filters.resourceType) params.set('resourceType', filters.resourceType);
      const res = await fetch(`/api/enterprise/audit/export?${params.toString()}`, { credentials: 'include' });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit-export-${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {}
  };

  const parseDetails = (detailsStr: string): Record<string, any> => {
    try { return JSON.parse(detailsStr); } catch { return {}; }
  };

  const actionColor = (action: string): string => {
    if (action.includes('create') || action.includes('submit') || action.includes('publish')) return 'text-green-400';
    if (action.includes('delete') || action.includes('reject') || action.includes('remove')) return 'text-red-400';
    if (action.includes('update') || action.includes('approve')) return 'text-blue-400';
    if (action.includes('login') || action.includes('register')) return 'text-purple-400';
    return 'text-white/50';
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <ScrollText size={24} className="text-amber-400" />
            Audit Log
          </h2>
          <p className="text-white/40 text-sm">{entries.length} entries</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setShowFilters(!showFilters)}
            className={`rounded-lg flex items-center gap-1 text-sm ${showFilters ? 'bg-amber-500/20 text-amber-400' : 'bg-white/10 text-white/70 hover:bg-white/20'}`}
          >
            <Filter size={14} /> Filters
          </Button>
          <Button
            onClick={handleExport}
            className="bg-white/10 hover:bg-white/20 text-white/70 rounded-lg flex items-center gap-1 text-sm"
          >
            <Download size={14} /> Export CSV
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      {showFilters && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-end gap-3"
        >
          <div className="flex-1">
            <label className="text-white/30 text-xs block mb-1">User ID</label>
            <input
              value={filters.userId}
              onChange={e => setFilters(f => ({ ...f, userId: e.target.value }))}
              placeholder="Filter by user..."
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none"
            />
          </div>
          <div className="flex-1">
            <label className="text-white/30 text-xs block mb-1">Action</label>
            <input
              value={filters.action}
              onChange={e => setFilters(f => ({ ...f, action: e.target.value }))}
              placeholder="e.g. template.create..."
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none"
            />
          </div>
          <div className="flex-1">
            <label className="text-white/30 text-xs block mb-1">Resource Type</label>
            <input
              value={filters.resourceType}
              onChange={e => setFilters(f => ({ ...f, resourceType: e.target.value }))}
              placeholder="e.g. agent_template..."
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none"
            />
          </div>
          <Button onClick={handleFilter} className="bg-amber-600 hover:bg-amber-500 text-white rounded-lg flex items-center gap-1">
            <Search size={14} /> Search
          </Button>
        </motion.div>
      )}

      {/* Entries */}
      {loading ? (
        <div className="text-center py-12 text-white/30"><Loader2 size={24} className="mx-auto animate-spin" /></div>
      ) : entries.length === 0 ? (
        <div className="text-center py-12 text-white/30">
          <ScrollText size={32} className="mx-auto mb-2 opacity-30" />
          No audit entries found
        </div>
      ) : (
        <div className="space-y-1">
          {entries.map(entry => {
            const details = parseDetails(entry.details);
            return (
              <div
                key={entry.id}
                className="bg-white/5 border border-white/5 rounded-lg px-4 py-3 flex items-center gap-4 hover:bg-white/[0.07] transition-colors"
              >
                <Clock size={12} className="text-white/20 flex-shrink-0" />
                <span className="text-white/20 text-xs font-mono min-w-[140px]">
                  {new Date(entry.timestamp).toLocaleString()}
                </span>
                <span className={`text-xs font-medium min-w-[160px] ${actionColor(entry.action)}`}>
                  {entry.action}
                </span>
                <div className="flex items-center gap-1 text-white/30 text-xs min-w-[120px]">
                  <User size={10} /> {entry.userId.slice(0, 10)}...
                </div>
                <div className="flex items-center gap-1 text-white/30 text-xs min-w-[120px]">
                  <FileText size={10} /> {entry.resourceType}
                </div>
                <span className="text-white/20 text-xs font-mono flex-1 truncate">
                  {Object.keys(details).length > 0 ? JSON.stringify(details).slice(0, 60) : '-'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
