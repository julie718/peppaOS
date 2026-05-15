import React, { useState } from 'react';
import {
  Building2, BookOpen, Package, Users, Settings,
  ClipboardCheck, ScrollText, MessageSquare, ArrowLeft,
  Shield, User, Briefcase, Home,
} from 'lucide-react';
import { BranchDashboard } from './BranchDashboard';
import { KnowledgeBaseBrowser } from './KnowledgeBaseBrowser';
import { KnowledgeBaseEditor } from './KnowledgeBaseEditor';
import { TemplateMarketplace } from './TemplateMarketplace';
import { TemplateCreator } from './TemplateCreator';
import { TemplateReviewQueue } from './TemplateReviewQueue';
import { CentralLumiChat } from './CentralLumiChat';
import { OrgMembers } from './OrgMembers';
import { OrgSettings } from './OrgSettings';
import { AuditLogViewer } from './AuditLogViewer';
import { useApp } from '../../contexts/AppContext';

type SubView = 'dashboard' | 'kb' | 'kb-edit' | 'templates' | 'templates-create' | 'review' | 'chat' | 'members' | 'settings' | 'audit';

interface NavItem {
  id: SubView;
  label: string;
  icon: React.ReactNode;
  roles: Array<'owner' | 'admin' | 'member' | 'viewer'>;
}

const allNavItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <Home size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
  { id: 'chat', label: 'Company Lumi', icon: <MessageSquare size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
  { id: 'kb', label: 'Knowledge Base', icon: <BookOpen size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
  { id: 'templates', label: 'Templates', icon: <Package size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
  { id: 'review', label: 'Review', icon: <ClipboardCheck size={16} />, roles: ['owner', 'admin'] },
  { id: 'members', label: 'Members', icon: <Users size={16} />, roles: ['owner', 'admin'] },
  { id: 'audit', label: 'Audit Log', icon: <ScrollText size={16} />, roles: ['owner', 'admin'] },
  { id: 'settings', label: 'Settings', icon: <Settings size={16} />, roles: ['owner', 'admin'] },
];

const roleLabel: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  owner:  { label: 'Owner',  icon: <Shield size={10} />, color: 'text-amber-400 bg-amber-500/10' },
  admin:  { label: 'Admin',  icon: <Shield size={10} />, color: 'text-red-400 bg-red-500/10' },
  member: { label: 'Member', icon: <User size={10} />,   color: 'text-blue-400 bg-blue-500/10' },
  viewer: { label: 'Viewer', icon: <User size={10} />,   color: 'text-white/40 bg-white/5' },
};

export function EnterpriseHub() {
  const [subView, setSubView] = useState<SubView>('dashboard');
  const { workDomain, switchDomain, orgConnection } = useApp();

  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tab === 'enterprise' && detail?.sub) {
        setSubView(detail.sub as SubView);
      }
    };
    window.addEventListener('lumi:navigate', handler);
    return () => window.removeEventListener('lumi:navigate', handler);
  }, []);

  const orgRole = orgConnection?.orgRole || 'member';
  const visibleItems = allNavItems.filter(item => item.roles.includes(orgRole as any));
  const roleInfo = roleLabel[orgRole] || roleLabel.member;

  const renderView = () => {
    switch (subView) {
      case 'dashboard': return <BranchDashboard />;
      case 'kb': return <KnowledgeBaseBrowser />;
      case 'kb-edit': return <KnowledgeBaseEditor onSaved={() => setSubView('kb')} />;
      case 'templates': return <TemplateMarketplace />;
      case 'templates-create': return <TemplateCreator />;
      case 'review': return <TemplateReviewQueue />;
      case 'chat': return <CentralLumiChat />;
      case 'members': return <OrgMembers />;
      case 'settings': return <OrgSettings />;
      case 'audit': return <AuditLogViewer />;
      default: return <BranchDashboard />;
    }
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-56 border-r border-white/5 bg-white/[0.02] flex flex-col">
        <div className="p-4 border-b border-white/5 space-y-3">
          <h3 className="text-white text-sm font-bold flex items-center gap-2">
            <Building2 size={16} className="text-blue-400" />
            Work Space
          </h3>
          {orgConnection?.orgName && (
            <p className="text-white/30 text-[10px]">{orgConnection.orgName}</p>
          )}
          {/* Role badge */}
          <span className={`text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${roleInfo.color}`}>
            {roleInfo.icon} {roleInfo.label}
          </span>
          {/* Domain switch */}
          <button
            onClick={() => switchDomain(workDomain === 'personal' ? 'work' : 'personal')}
            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all ${
              workDomain === 'work'
                ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                : 'bg-white/5 text-white/40 border border-white/5 hover:text-white/60'
            }`}
          >
            {workDomain === 'work' ? <Briefcase size={12} /> : <User size={12} />}
            {workDomain === 'work' ? 'Work Domain' : 'Personal Domain'}
          </button>
        </div>

        <nav className="flex-1 p-2 space-y-1">
          {visibleItems.map(item => (
            <button
              key={item.id}
              onClick={() => setSubView(item.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all ${
                subView === item.id
                  ? 'bg-blue-500/10 text-blue-400'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/5'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
          <div className="my-2 border-t border-white/5" />
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'home' } }))}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-white/40 hover:text-white/60 hover:bg-white/5 transition-all"
          >
            <ArrowLeft size={16} />
            Exit Work Space
          </button>
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {renderView()}
      </div>
    </div>
  );
}
