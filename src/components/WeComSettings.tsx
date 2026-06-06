// Enterprise WeChat (企业微信) settings panel
import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';
import { ExternalLink, CheckCircle, Loader2 } from 'lucide-react';

export function WeComSettings({ t }: { t?: any }) {
  const [config, setConfig] = useState<any>(null);
  const [form, setForm] = useState({ corpId: '', agentId: '', appSecret: '', token: '', encodingAESKey: '' });
  const [saving, setSaving] = useState(false);

  const load = () => {
    fetch('/api/wecom/config', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setConfig(d);
        setForm({ corpId: d.corpId || '', agentId: d.agentId || '', appSecret: '', token: '', encodingAESKey: '' });
      })
      .catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const body: any = {};
      if (form.corpId) body.corpId = form.corpId;
      if (form.agentId) body.agentId = form.agentId;
      if (form.appSecret) body.appSecret = form.appSecret;
      if (form.token) body.token = form.token;
      if (form.encodingAESKey) body.encodingAESKey = form.encodingAESKey;
      const res = await fetch('/api/wecom/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d.success) { toast.success(t?.saved || 'Saved'); load(); }
      else toast.error(d.error || 'Save failed');
    } catch { toast.error('Network error'); }
    finally { setSaving(false); }
  };

  const configured = config?.corpId && config?.hasSecret;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-black uppercase tracking-widest text-white/40">{t?.status || 'Status'}</span>
        <span className={`text-xs font-bold px-3 py-1 rounded-full ${configured ? 'bg-green-500/10 text-green-400' : 'bg-white/5 text-white/55'}`}>
          <CheckCircle size={10} className="inline mr-1" />
          {configured ? (t?.connected || 'Connected') : (t?.notConfigured || 'Not configured')}
        </span>
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs font-bold text-white/40 uppercase block mb-1">Corp ID (企业ID)</label>
          <Input value={form.corpId} onChange={e => setForm(prev => ({ ...prev, corpId: e.target.value }))}
            className="bg-white/5 border-white/10 rounded-xl text-white text-xs" placeholder="ww..." />
        </div>
        <div>
          <label className="text-xs font-bold text-white/40 uppercase block mb-1">Agent ID (应用ID)</label>
          <Input value={form.agentId} onChange={e => setForm(prev => ({ ...prev, agentId: e.target.value }))}
            className="bg-white/5 border-white/10 rounded-xl text-white text-xs" placeholder="1000001" />
        </div>
        <div>
          <label className="text-xs font-bold text-white/40 uppercase block mb-1">App Secret (应用Secret)</label>
          <Input type="password" value={form.appSecret} onChange={e => setForm(prev => ({ ...prev, appSecret: e.target.value }))}
            className="bg-white/5 border-white/10 rounded-xl text-white text-xs" placeholder={config?.hasSecret ? '(stored)' : ''} />
        </div>
        <div>
          <label className="text-xs font-bold text-white/40 uppercase block mb-1">Token (回调Token)</label>
          <Input value={form.token} onChange={e => setForm(prev => ({ ...prev, token: e.target.value }))}
            className="bg-white/5 border-white/10 rounded-xl text-white text-xs" placeholder="随机字符串" />
        </div>
        <div>
          <label className="text-xs font-bold text-white/40 uppercase block mb-1">Encoding AES Key</label>
          <Input value={form.encodingAESKey} onChange={e => setForm(prev => ({ ...prev, encodingAESKey: e.target.value }))}
            className="bg-white/5 border-white/10 rounded-xl text-white text-xs font-mono" placeholder="43位Base64字符串" />
        </div>
      </div>

      <Button onClick={save} disabled={saving} className="w-full bg-celestial-saturn hover:bg-celestial-saturn/90 text-black font-bold rounded-xl h-10">
        {saving ? <Loader2 size={14} className="animate-spin" /> : (t?.save || 'Save')}
      </Button>

      <div className="p-3 rounded-xl bg-white/5 border border-white/5 text-xs text-white/55 space-y-1">
        <p>1. <a href="https://work.weixin.qq.com/wework_admin/frame#apps" target="_blank" rel="noopener noreferrer" className="text-celestial-saturn underline inline-flex items-center gap-0.5">企业微信管理后台 <ExternalLink size={9} /></a> 创建应用</p>
        <p>2. 复制 Corp ID、Agent ID、App Secret</p>
        <p>3. 「接收消息」→ 设置回调 URL：<code className="text-celestial-jupiter bg-white/5 px-1 rounded">https://lumiai.asia/api/wecom/events</code></p>
        <p>4. 随机生成 Token 和 EncodingAESKey（推荐 43 位），填入上面表单并保存</p>
        <p>5. 回到企业微信后台，填入相同的 Token 和 AESKey，点击「保存」完成验证</p>
      </div>
    </div>
  );
}
