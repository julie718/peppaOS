// Web entry — landing page, ecosystem, settings, etc.
import { useState, useEffect } from 'react';
import { ProactiveNotifications } from '../components/ProactiveNotifications';
import { LoginModal } from '../core/components/Auth';
import { Toaster } from 'sonner';
import { motion } from 'motion/react';
import { Rocket } from 'lucide-react';
import '@fontsource-variable/geist';
import '../index.css';
import { WebPlatform } from '../platforms/web/WebPlatform';
import { FloatingAgent } from '../components/FloatingAgent';
import { ProtocolsWorld } from '../components/ProtocolsWorld';
import { LumiEcosystem } from '../components/LumiEcosystem';
import { SkillMarketplace } from '../components/SkillMarketplace';
import { AgentChatPage } from '../components/AgentChatPage';
import { LoginRequired } from '../core/components/Auth';
import { MultimodalProducts } from '../components/MultimodalProducts';
import { ProductDetailPage } from '../components/ProductDetailPage';
import { Docs } from '../components/Docs';
import { Solutions } from '../components/Solutions';
import { JoinUs } from '../components/JoinUs';
import { FoundersSanctuary } from '../components/FoundersSanctuary';
import { Profile } from '../components/Profile';
import { Settings } from '../components/Settings';
import { useAppShell } from './useAppShell';
import { usePlatform } from '../hooks/usePlatform';

export function WebApp() {
  const { isDesktop } = usePlatform();
  const shell = useAppShell();
  const [activeTab, setActiveTab] = useState('home');
  const [selectedAgent, setSelectedAgent] = useState<any>(null);
  const [selectedProduct, setSelectedProduct] = useState<any>(null);

  useEffect(() => { window.scrollTo(0, 0); }, [activeTab]);

  if (shell.loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-celestial-deep">
        <motion.div animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }} transition={{ duration: 2, repeat: Infinity }} className="flex flex-col items-center gap-4">
          <Rocket size={48} className="text-celestial-saturn" />
          <div className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-celestial-mars to-celestial-saturn">Lumi Core v2.0 Initializing...</div>
        </motion.div>
      </div>
    );
  }

  const renderTabContent = (tab: string) => {
    switch (tab) {
      case 'home': return null;
      case 'protocols': return <ProtocolsWorld t={shell.t} />;
      case 'marketplace': case 'ecosystem':
        return <div className="space-y-24"><LumiEcosystem t={shell.t} onChatAgent={(a: any) => { setSelectedAgent(a); setActiveTab('agent-chat'); }} /><SkillMarketplace t={shell.t} lang={shell.lang} /></div>;
      case 'agent-chat': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <AgentChatPage t={shell.t} user={shell.user} agent={selectedAgent} isOpen={true} onClose={() => setActiveTab('ecosystem')} />;
      case 'multimodal': return <MultimodalProducts t={shell.t} onSelectProduct={(p: any) => { setSelectedProduct(p); setActiveTab('product-detail'); }} />;
      case 'product-detail': return selectedProduct ? <ProductDetailPage t={shell.t} product={selectedProduct} onBack={() => setActiveTab('multimodal')} /> : <MultimodalProducts t={shell.t} onSelectProduct={(p: any) => { setSelectedProduct(p); setActiveTab('product-detail'); }} />;
      case 'docs': return <Docs t={shell.t} />;
      case 'solutions': return <Solutions t={shell.t} />;
      case 'join': return <JoinUs t={shell.t} />;
      case 'founders': return <FoundersSanctuary t={shell.t} user={shell.user} onBack={() => setActiveTab('home')} />;
      case 'profile': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Profile t={shell.t} />;
      case 'enterprise': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <div className="p-8 text-center text-white/40">{shell.t.enterpriseUseWorkbench || 'Enterprise features are available in the Enterprise Workbench.'}</div>;
      case 'settings': return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Settings t={shell.t} lang={shell.lang} setLang={shell.setLang} />;
      case 'voice': case 'memory': case 'mcp': case 'personality': case 'sync':
        return !shell.user ? <LoginRequired t={shell.t} onLogin={shell.handleLogin} /> : <Settings t={shell.t} lang={shell.lang} setLang={shell.setLang} activeSection={tab} />;
      default: return null;
    }
  };

  return (
    <div className="min-h-screen bg-celestial-deep overflow-x-hidden">
      <ProactiveNotifications />
      <Toaster position="top-right" theme="dark" />
      <WebPlatform user={shell.user} activeTab={activeTab} setActiveTab={setActiveTab} lang={shell.lang} setLang={shell.setLang} t={shell.t}
        onLogin={shell.handleLogin} onLogout={shell.handleLogout} renderTabContent={renderTabContent} isDesktop={isDesktop} setUiMode={() => {}} />
      <LoginModal t={shell.t} isOpen={shell.isLoginModalOpen} onClose={() => shell.setIsLoginModalOpen(false)} onLoginSuccess={() => shell.refreshUser()} onGoogleLogin={shell.handleLogin} />
      {!isDesktop && <FloatingAgent t={shell.t} />}
    </div>
  );
}
