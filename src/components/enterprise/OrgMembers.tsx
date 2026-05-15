import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Users, UserPlus, Shield, UserMinus, Loader2, Crown, User } from 'lucide-react';
import { Button } from '../ui/button';

interface Member {
  id: string;
  userId: string;
  role: string;
  status: string;
  departmentId: string | null;
  joinedAt: string | null;
}

export function OrgMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState('');
  const [inviteUserId, setInviteUserId] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    loadOrgAndMembers();
  }, []);

  const loadOrgAndMembers = async () => {
    try {
      const orgsRes = await fetch('/api/enterprise/org', { credentials: 'include' });
      if (!orgsRes.ok) return;
      const orgs = await orgsRes.json();
      if (orgs.length === 0) return;
      const orgIdVal = orgs[0].id || orgs[0].orgId;
      setOrgId(orgIdVal);

      const membersRes = await fetch(`/api/enterprise/org/${orgIdVal}/members`, { credentials: 'include' });
      if (membersRes.ok) setMembers(await membersRes.json());
    } catch {} finally { setLoading(false); }
  };

  const handleInvite = async () => {
    if (!inviteUserId.trim() || !orgId) return;
    setInviting(true);
    try {
      const res = await fetch(`/api/enterprise/org/${orgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: inviteUserId, role: inviteRole }),
        credentials: 'include',
      });
      if (res.ok) {
        setInviteUserId('');
        loadOrgAndMembers();
      }
    } catch {} finally { setInviting(false); }
  };

  const handleRemove = async (userId: string) => {
    try {
      await fetch(`/api/enterprise/org/${orgId}/members/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      loadOrgAndMembers();
    } catch {}
  };

  const roleBadge = (role: string) => {
    const map: Record<string, { color: string; icon: React.ReactNode }> = {
      owner: { color: 'text-amber-400 bg-amber-500/10', icon: <Crown size={10} /> },
      admin: { color: 'text-red-400 bg-red-500/10', icon: <Shield size={10} /> },
      member: { color: 'text-blue-400 bg-blue-500/10', icon: <User size={10} /> },
      viewer: { color: 'text-white/40 bg-white/5', icon: <User size={10} /> },
    };
    const s = map[role] || map.member;
    return (
      <span className={`text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 ${s.color}`}>
        {s.icon} {role}
      </span>
    );
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <Users size={24} className="text-green-400" />
          Organization Members
        </h2>
        <p className="text-white/40 text-sm">{members.length} member(s)</p>
      </div>

      {/* Invite */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-end gap-3">
        <div className="flex-1">
          <label className="text-white/30 text-xs mb-1 block">Invite User by ID</label>
          <input
            value={inviteUserId}
            onChange={e => setInviteUserId(e.target.value)}
            placeholder="User ID..."
            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none"
          />
        </div>
        <div>
          <label className="text-white/30 text-xs mb-1 block">Role</label>
          <select
            value={inviteRole}
            onChange={e => setInviteRole(e.target.value)}
            className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white/70 text-sm"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        <Button
          onClick={handleInvite}
          disabled={inviting || !inviteUserId.trim()}
          className="bg-green-600 hover:bg-green-500 text-white rounded-lg flex items-center gap-1"
        >
          {inviting ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
          Add
        </Button>
      </div>

      {/* Members list */}
      {loading ? (
        <div className="text-center py-12 text-white/30"><Loader2 size={24} className="mx-auto animate-spin" /></div>
      ) : (
        <div className="space-y-2">
          {members.map(member => (
            <motion.div
              key={member.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center justify-between hover:bg-white/[0.07]"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center">
                  <User size={16} className="text-white/60" />
                </div>
                <div>
                  <p className="text-white text-sm font-medium">{member.userId}</p>
                  <p className="text-white/30 text-xs">
                    {member.joinedAt ? `Joined ${new Date(member.joinedAt).toLocaleDateString()}` : 'Pending'}
                    {member.status !== 'active' && <span className="text-amber-400 ml-2">{member.status}</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {roleBadge(member.role)}
                {member.role !== 'owner' && (
                  <button
                    onClick={() => handleRemove(member.userId)}
                    className="p-1.5 rounded-lg hover:bg-red-500/10 text-white/20 hover:text-red-400 transition-colors"
                    title="Remove member"
                  >
                    <UserMinus size={14} />
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
