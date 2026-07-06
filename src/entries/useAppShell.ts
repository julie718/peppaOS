import { useState, useEffect } from 'react';
import { setLang } from '../lib/useT';
import { translations } from '../lib/translations';
import { useApp } from '../contexts/AppContext';

export function useAppShell() {
  const { user, loading, logout, refreshUser } = useApp();
  const [lang, setLangState] = useState<'en' | 'zh'>('zh');
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const t = translations[lang];

  useEffect(() => { setLang(lang); }, [lang]);
  useEffect(() => {
    const handler = () => setIsLoginModalOpen(true);
    window.addEventListener('peppa:open-login', handler);
    return () => window.removeEventListener('peppa:open-login', handler);
  }, []);

  return {
    user, loading, lang, setLang: setLangState, t,
    handleLogin: () => setIsLoginModalOpen(true),
    handleLogout: async () => { await logout(); },
    isLoginModalOpen, setIsLoginModalOpen, refreshUser,
  };
}
