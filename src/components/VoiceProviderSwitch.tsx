// STT / TTS provider switch — Local ←→ Cloud
import { useState, useEffect } from 'react';
import { Cpu, Cloud } from 'lucide-react';

export function VoiceProviderSwitch({ t }: { t?: any }) {
  const [pref, setPref] = useState<{ stt: string; tts: string }>({ stt: 'auto', tts: 'auto' });
  const [active, setActive] = useState<{ stt: string; tts: string }>({ stt: '?', tts: '?' });

  const load = () => {
    fetch('/api/voice/active-provider')
      .then(r => r.json())
      .then(d => { setPref(d.pref); setActive(d.active); })
      .catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const save = async (stt: string, tts: string) => {
    await fetch('/api/voice/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stt, tts }),
    });
    load();
  };

  const sttOpts = [
    { value: 'auto', label: t?.auto || 'Auto' },
    { value: 'local-whisper', label: t?.local || 'Local' },
    { value: 'qwen', label: 'Qwen ASR' },
    { value: 'deepgram', label: 'Deepgram' },
    { value: 'whisper', label: 'Whisper' },
  ];

  const ttsOpts = [
    { value: 'auto', label: t?.auto || 'Auto' },
    { value: 'gptsovits', label: t?.local || 'Local' },
    { value: 'cosyvoice', label: 'CosyVoice' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-widest text-white/40">{t?.sttProvider || 'STT'}</span>
        <div className="flex items-center gap-1">
          {active.stt === 'local-whisper' ? <Cpu size={12} className="text-emerald-400" /> : <Cloud size={12} className="text-blue-400" />}
          <span className="text-[9px] font-mono text-white/30">{active.stt}</span>
        </div>
      </div>
      <div className="flex gap-2">
        {sttOpts.map(o => (
          <button
            key={o.value}
            onClick={() => save(o.value, pref.tts)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
              pref.stt === o.value
                ? 'bg-celestial-saturn text-black'
                : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >{o.label}</button>
        ))}
      </div>

      <div className="flex items-center justify-between mt-4">
        <span className="text-[10px] font-black uppercase tracking-widest text-white/40">{t?.ttsProvider || 'TTS'}</span>
        <div className="flex items-center gap-1">
          {active.tts === 'gptsovits' ? <Cpu size={12} className="text-emerald-400" /> : <Cloud size={12} className="text-blue-400" />}
          <span className="text-[9px] font-mono text-white/30">{active.tts}</span>
        </div>
      </div>
      <div className="flex gap-2">
        {ttsOpts.map(o => (
          <button
            key={o.value}
            onClick={() => save(pref.stt, o.value)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
              pref.tts === o.value
                ? 'bg-celestial-saturn text-black'
                : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >{o.label}</button>
        ))}
      </div>
    </div>
  );
}
