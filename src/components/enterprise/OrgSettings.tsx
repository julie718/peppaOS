import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Building2, Settings, Save, Loader2, Trash2, Link, Copy, CheckCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { useT } from '../../lib/useT';

export function OrgSettings() {
  const t = useT();
  const [org, setOrg] = useState<any>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [invitationCode, setInvitationCode] = useState('');
  const [invitationRole, setInvitationRole] = useState('member');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadOrg();
  }, []);

  const loadOrg = async () => {
    try {
      const orgsRes = await fetch('/api/enterprise/org', { credentials: 'include' });
      if (!orgsRes.ok) return;
      const orgs = await orgsRes.json();
      if (orgs.length === 0) return;

      const orgDetailRes = await fetch(`/api/enterprise/org/${orgs[0].id}`, { credentials: 'include' });
      if (orgDetailRes.ok) {
        const orgData = await orgDetailRes.json();
        setOrg(orgData);
        setName(orgData.name);
      }
    } catch {} finally { setLoading(false); }
  };

  const handleSave = async () => {
    if (!org || !name.trim()) return;
    setSaving(true);
    try {
      await fetch(`/api/enterprise/org/${org.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        credentials: 'include',
      });
      loadOrg();
    } catch {} finally { setSaving(false); }
  };

  const handleCreateInvitation = async () => {
    if (!org) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/enterprise/org/${org.id}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: invitationRole, maxUses: 0 }),
        credentials: 'include',
      });
      if (res.ok) {
        const inv = await res.json();
        setInvitationCode(inv.code);
      }
    } catch {} finally { setGenerating(false); }
  };

  const copyCode = () => {
    navigator.clipboard.writeText(invitationCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="p-6 text-center text-white/30">
        <Loader2 size={24} className="mx-auto animate-spin" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="p-6 text-center text-white/30">
        <Building2 size={32} className="mx-auto mb-2 opacity-30" />
        No organization found. Create one first.
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <h2 className="text-xl font-bold text-white flex items-center gap-2">
        <Settings size={24} className="text-white/40" />
        {t.enterpriseSettings}
      </h2>

      {/* General */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-6 space-y-4">
        <h3 className="text-white font-medium">General</h3>
        <div>
          <label className="text-white/30 text-xs block mb-1">Organization Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/40"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-white/30 text-xs">Slug: {org.slug}</span>
          <span className="text-white/20 text-xs">ID: {org.id.slice(0, 8)}...</span>
        </div>
        <Button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="bg-blue-600 hover:bg-blue-500 text-white rounded-lg flex items-center gap-2"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Changes
        </Button>
      </div>

      {/* Invitations */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-6 space-y-4">
        <h3 className="text-white font-medium">Invitation Codes</h3>
        <p className="text-white/40 text-xs">
          Generate an invitation code for new members. Share the 8-character code.
        </p>
        <div className="flex items-end gap-3">
          <div>
            <label className="text-white/30 text-xs block mb-1">Default Role</label>
            <select
              value={invitationRole}
              onChange={e => setInvitationRole(e.target.value)}
              className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white/70 text-sm"
            >
              <option value="member">{t.enterpriseRoleMember}</option>
              <option value="admin">{t.enterpriseRoleAdmin}</option>
              <option value="viewer">{t.enterpriseRoleViewer}</option>
            </select>
          </div>
          <Button
            onClick={handleCreateInvitation}
            disabled={generating}
            className="bg-green-600 hover:bg-green-500 text-white rounded-lg flex items-center gap-2"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Link size={14} />}
            Generate Code
          </Button>
        </div>

        {invitationCode && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 flex items-center justify-between"
          >
            <div>
              <p className="text-white/30 text-xs mb-1">Invitation Code</p>
              <p className="text-2xl font-mono font-bold text-green-400 tracking-[0.2em]">
                {invitationCode}
              </p>
            </div>
            <Button
              onClick={copyCode}
              className="bg-white/10 hover:bg-white/20 text-white rounded-lg flex items-center gap-1"
            >
              {copied ? <CheckCircle size={14} className="text-green-400" /> : <Copy size={14} />}
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </motion.div>
        )}
      </div>

      {/* Danger zone */}
      <div className="bg-red-500/5 border border-red-500/10 rounded-xl p-6 space-y-4">
        <h3 className="text-red-400 font-medium flex items-center gap-2">
          <Trash2 size={16} /> Danger Zone
        </h3>
        <p className="text-white/30 text-xs">
          Deleting your organization is irreversible. All KB articles, templates, and member data will be permanently removed.
        </p>
        <Button
          onClick={() => {
            if (confirm('This action is irreversible. Are you sure?')) {
              fetch(`/api/enterprise/org/${org.id}`, { method: 'DELETE', credentials: 'include' })
                .then(() => window.location.reload());
            }
          }}
          className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/20 rounded-lg"
        >
          Delete Organization
        </Button>
      </div>
    </div>
  );
}
