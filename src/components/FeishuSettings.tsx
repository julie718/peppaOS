import React, { useState, useEffect } from 'react';
import { MessagesSquare, Save, Key, ExternalLink, CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';

export function FeishuSettings({ t }: { t?: any }) {
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [configured, setConfigured] = useState(false);
  const [appIdMasked, setAppIdMasked] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  useEffect(() => {
    fetch('/api/feishu/config')
      .then(r => r.json())
      .then(d => {
        setAppId(d.appId || '');
        setAppIdMasked(d.appIdMasked || '');
        setConfigured(d.enabled);
      })
      .catch(() => toast.error(t?.failedToLoadConfig || 'Failed to load config'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (!appId.trim()) {
      toast.error('App ID 不能为空');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/feishu/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: appId.trim(),
          appSecret: appSecret.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setConfigured(data.configured);
        setAppIdMasked(data.appId || '');
        if (appSecret.trim()) setAppSecret('');
        toast.success('飞书配置已保存');
      } else {
        toast.error(data.error || (t?.saveFailed || 'Save failed'));
      }
    } catch (err: any) {
      toast.error(`${t?.saveFailed || 'Save failed'}: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-xs font-black uppercase tracking-widest text-white/45">加载中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status Bar */}
      <div className="flex items-center gap-3 p-4 rounded-xl bg-white/5 border border-white/10">
        <div className={`w-3 h-3 rounded-full ${configured ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-white/20'}`} />
        <div>
          <div className="text-sm font-bold text-white">
            {configured ? '飞书已连接' : '飞书未配置'}
          </div>
          <div className="text-xs text-white/40 uppercase tracking-widest">
            {configured ? `App ID: ${appIdMasked}` : '请输入 App ID 和 App Secret'}
          </div>
        </div>
        {configured ? (
          <CheckCircle size={16} className="text-green-500 ml-auto" />
        ) : (
          <AlertCircle size={16} className="text-white/45 ml-auto" />
        )}
      </div>

      {/* Config Form */}
      <div className="space-y-4">
        <div>
          <label className="text-xs font-black uppercase tracking-widest text-white/50 block mb-2">
            <Key size={12} className="inline mr-1" /> App ID
          </label>
          <Input
            value={appId}
            onChange={e => setAppId(e.target.value)}
            placeholder="cli_xxxxxxxxxxxxxxxx"
            className="bg-white/5 border-white/10 text-white text-xs h-10 font-mono placeholder:text-white/45"
          />
        </div>

        <div>
          <label className="text-xs font-black uppercase tracking-widest text-white/50 block mb-2">
            <Key size={12} className="inline mr-1" /> App Secret
          </label>
          <div className="relative">
            <Input
              type={showSecret ? 'text' : 'password'}
              value={appSecret}
              onChange={e => setAppSecret(e.target.value)}
              placeholder={configured ? '留空则保持现有密钥不变' : '输入 App Secret'}
              className="bg-white/5 border-white/10 text-white text-xs h-10 font-mono placeholder:text-white/45 pr-12"
            />
            <button
              onClick={() => setShowSecret(!showSecret)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-black uppercase tracking-widest text-white/55 hover:text-white/60"
            >
              {showSecret ? '隐藏' : '显示'}
            </button>
          </div>
        </div>

        <Button
          onClick={save}
          disabled={saving || !appId.trim()}
          className="w-full h-10 bg-white/10 hover:bg-white/15 border border-white/10 text-xs font-black uppercase tracking-widest"
        >
          <Save size={14} className="mr-2" />
          {saving ? '保存中...' : '保存配置'}
        </Button>
      </div>

      {/* Setup Guide */}
      <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-white/60">
          <MessagesSquare size={14} />
          飞书机器人接入指南
        </div>
        <div className="space-y-2 text-xs text-white/40 leading-relaxed">
          <p>1. 前往 <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer" className="text-celestial-saturn underline inline-flex items-center gap-0.5">飞书开放平台<ExternalLink size={10} /></a> 创建应用</p>
          <p>2. 左侧菜单「应用能力」→ 启用「机器人」</p>
          <p>3. 左侧菜单「凭证与基础信息」→ 复制 App ID 和 App Secret</p>
          <p>4. 左侧菜单「事件订阅」→ 请求 URL 填：<code className="text-celestial-jupiter bg-white/5 px-1 rounded">https://lumiai.asia/api/feishu/events</code></p>
          <p>5. 订阅事件：添加「接收消息」im.message.receive_v1</p>
          <p>6. 左侧菜单「权限管理」→ 开通「获取并发送单聊、群聊消息」</p>
          <p>7. 左侧菜单「应用发布」→ 创建版本并发布</p>
        </div>
        <a
          href="https://open.feishu.cn/app"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-widest text-celestial-saturn hover:underline mt-2"
        >
          打开飞书开放平台 <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
