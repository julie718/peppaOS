import { motion } from 'motion/react';
import { Rocket } from 'lucide-react';
import { Toaster } from 'sonner';
import '@fontsource-variable/geist';
import '../index.css';
import { ProactiveNotifications } from '../components/ProactiveNotifications';
import { LoginModal, LoginRequired } from '../core/components/Auth';
import { AgentChatPage } from '../components/AgentChatPage';
import { useAppShell } from './useAppShell';

export function MobileApp() {
  const shell = useAppShell();

  if (shell.loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-black">
        <motion.div animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }} transition={{ duration: 2, repeat: Infinity }} className="flex flex-col items-center gap-4">
          <Rocket size={48} className="text-celestial-saturn" />
          <div className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-celestial-mars to-celestial-saturn">Peppa Mobile Preview</div>
        </motion.div>
      </div>
    );
  }

  if (!shell.user) {
    return (
      <>
        <ProactiveNotifications />
        <Toaster position="top-right" theme="dark" />
        <div className="h-dvh flex items-center justify-center bg-black">
          <LoginRequired t={shell.t} onLogin={shell.handleLogin} />
        </div>
        <LoginModal t={shell.t} isOpen={shell.isLoginModalOpen} onClose={() => shell.setIsLoginModalOpen(false)} onLoginSuccess={() => shell.refreshUser()} onGoogleLogin={shell.handleLogin} />
      </>
    );
  }

  return (
    <div className="fixed inset-0 bg-black overflow-hidden" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <ProactiveNotifications />
      <Toaster position="top-right" theme="dark" />
      <AgentChatPage t={shell.t} user={shell.user} agent={{ id: 'peppa', name: 'Peppa' }} isOpen={true} onClose={() => {}} />
      <LoginModal t={shell.t} isOpen={shell.isLoginModalOpen} onClose={() => shell.setIsLoginModalOpen(false)} onLoginSuccess={() => shell.refreshUser()} onGoogleLogin={shell.handleLogin} />
    </div>
  );
}
