import { motion } from 'motion/react';
import { Rocket } from 'lucide-react';
import { Toaster } from 'sonner';
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
    <div className="fixed inset-0 bg-black overflow-hidden overscroll-none touch-none" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div style={{position:'fixed',top:0,left:0,zIndex:9999,background:'lime',color:'black',padding:'4px 8px',fontSize:'14px',fontWeight:'bold'}}>MOBILE-TSX-LOADED</div>
      <style>{`
        html, body {
          font-family: system-ui, "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif !important;
        }

        /* ── 手机版聊天气泡文字 13px→17px ── */
        [class*="max-w-[85%]"], [class*="max-w-[92%]"] {
          max-width: 67% !important;
        }
        [class*="relative max-w-"][class*="rounded-2xl"][class*="text-xs"] {
          font-size: 17px !important;
          line-height: 1.35 !important;
        }
        [class*="text-sm leading-relaxed"] {
          font-size: 17px !important;
          line-height: 1.35 !important;
        }

        /* ── 输入框 34px→42px，字 13px→16px ── */
        input[placeholder*="Communicate"], input[placeholder*="输入消息"] {
          font-size: 16px !important;
        }

        [class*=\"right-4\"][class*=\"bottom-28\"][class*=\"fixed\"]{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;width:0!important;height:0!important}
      `}</style>
      <ProactiveNotifications />
      <Toaster position="top-right" theme="dark" />
      {/* 模式切换栏 */}
      {shell.user && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/[0.06] shrink-0 overflow-x-auto relative z-[220] bg-black">
          {([
            { mode: 'chat' as const, label: '聊天', icon: '💬' },
            { mode: 'assistant' as const, label: '助手', icon: '⚡' },
            { mode: 'autonomous' as const, label: '自主', icon: '🤖' },
          ]).map(item => {
            const active = shell.operationMode === item.mode;
            return (
              <button
                key={item.mode}
                type="button"
                onClick={() => shell.setOperationMode(item.mode)}
                className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                  active
                    ? 'bg-white text-black'
                    : 'bg-white/[0.06] text-white/60 hover:bg-white/10'
                }`}
              >
                <span className={`flex h-5 w-5 items-center justify-center rounded-md text-[11px] ${active ? 'bg-black/10' : 'bg-white/10'}`}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            );
          })}
        </div>
      )}
      <AgentChatPage t={shell.t} user={shell.user} agent={{ id: 'peppa', name: 'Peppa' }} isOpen={true} onClose={() => {}} />
      <LoginModal t={shell.t} isOpen={shell.isLoginModalOpen} onClose={() => shell.setIsLoginModalOpen(false)} onLoginSuccess={() => shell.refreshUser()} onGoogleLogin={shell.handleLogin} />
    </div>
  );
}
