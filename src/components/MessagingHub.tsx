// Messaging Hub — toggle between Feishu and WeChat Work settings
import { useState } from 'react';
import { FeishuSettings } from './FeishuSettings';
import { WeComSettings } from './WeComSettings';
import { WeChatSettings } from './WeChatSettings';
import { MessageCircle } from 'lucide-react';

export function MessagingHub({ t }: { t?: any }) {
  const [tab, setTab] = useState<'wechat' | 'wecom' | 'feishu'>('wechat');

  return (
    <div className="space-y-6">
      <div className="flex gap-2 p-1 bg-white/5 rounded-xl border border-white/5">
        <button
          onClick={() => setTab('wechat')}
          className={`flex-1 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${
            tab === 'wechat' ? 'bg-green-500 text-white' : 'text-white/40 hover:text-white'
          }`}
        >
          <MessageCircle size={12} className="inline mr-1" />
          {t?.wechat || 'WeChat'}
        </button>
        <button
          onClick={() => setTab('wecom')}
          className={`flex-1 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${
            tab === 'wecom' ? 'bg-celestial-saturn text-black' : 'text-white/40 hover:text-white'
          }`}
        >
          <MessageCircle size={12} className="inline mr-1" />
          {t?.wecom || 'WeCom'}
        </button>
        <button
          onClick={() => setTab('feishu')}
          className={`flex-1 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${
            tab === 'feishu' ? 'bg-blue-500 text-white' : 'text-white/40 hover:text-white'
          }`}
        >
          <MessageCircle size={12} className="inline mr-1" />
          {t?.feishu || 'Feishu'}
        </button>
      </div>
      {tab === 'feishu' ? <FeishuSettings t={t} /> : tab === 'wecom' ? <WeComSettings t={t} /> : <WeChatSettings t={t} />}
    </div>
  );
}
