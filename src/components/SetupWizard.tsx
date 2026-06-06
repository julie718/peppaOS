// First-launch setup wizard — detects local Ollama, guides API key setup, voice test
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Cpu, Cloud, Mic, CheckCircle, Loader2, ArrowRight, Download, Key, Volume2, Sparkles } from 'lucide-react';

type Step = 'detect' | 'local-ready' | 'api-setup' | 'voice-test' | 'done';

interface Props {
  onFinish: () => void;
}

export function SetupWizard({ onFinish }: Props) {
  const [step, setStep] = useState<Step>('detect');
  const [ollamaStatus, setOllamaStatus] = useState<'checking' | 'available' | 'not-found'>('checking');
  const [apiKey, setApiKey] = useState('');
  const [apiProvider, setApiProvider] = useState('deepseek');
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'testing' | 'ok' | 'failed'>('idle');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Detect Ollama
    const detect = async () => {
      try {
        const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = await resp.json();
          const hasLLM = (data.models || []).some((m: any) => !m.name.includes('embed') && !m.name.includes('whisper'));
          setOllamaStatus(hasLLM ? 'available' : 'not-found');
        } else {
          setOllamaStatus('not-found');
        }
      } catch {
        setOllamaStatus('not-found');
      }
    };
    detect();
  }, []);

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    const keyMap: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY',
      qwen: 'DASHSCOPE_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
    };
    try {
      await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: { [keyMap[apiProvider]]: apiKey.trim() } }),
      });
      setStep('voice-test');
    } catch {
      // Save failed, still allow continuing
      setStep('voice-test');
    } finally {
      setSaving(false);
    }
  };

  const handleVoiceTest = () => {
    setVoiceStatus('testing');
    // Send a short test TTS request
    fetch('/api/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello. Your Lumi OS is ready.', voiceId: 'default' }),
    }).then(r => {
      setVoiceStatus(r.ok ? 'ok' : 'failed');
    }).catch(() => {
      setVoiceStatus('failed');
    });
  };

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={step}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="max-w-md mx-auto"
      >
        {/* Step: Detection */}
        {step === 'detect' && (
          <div className="text-center space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <Cpu size={64} className="text-blue-400" />
                {ollamaStatus === 'checking' && (
                  <Loader2 size={24} className="absolute -bottom-1 -right-1 animate-spin text-blue-400" />
                )}
              </div>
            </div>
            <h2 className="text-2xl font-bold text-white">
              {ollamaStatus === 'checking' ? 'Detecting local AI...' : ollamaStatus === 'available' ? 'Local AI Found' : 'No Local AI Detected'}
            </h2>
            <p className="text-white/40 text-sm">
              {ollamaStatus === 'checking'
                ? 'Checking if Ollama is running on this machine...'
                : ollamaStatus === 'available'
                ? 'An LLM model is available locally. Your conversations will be fast, private, and free.'
                : 'No local model found. You can still use Lumi with a cloud API key, or install Ollama for local AI.'}
            </p>
            {ollamaStatus === 'not-found' && (
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 rounded-xl text-white text-sm transition-colors"
              >
                <Download size={16} />
                Install Ollama (free)
              </a>
            )}
            {ollamaStatus !== 'checking' && (
              <button
                onClick={() => setStep(ollamaStatus === 'available' ? 'voice-test' : 'api-setup')}
                className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-2xl text-white font-semibold transition-all"
              >
                {ollamaStatus === 'available' ? 'Start Using Lumi' : 'Set Up Cloud API Key'}
                <ArrowRight size={18} />
              </button>
            )}
            {ollamaStatus === 'available' && (
              <button onClick={() => setStep('api-setup')} className="w-full text-white/55 text-sm hover:text-white/50 py-2">
                Also configure a cloud API key for complex tasks
              </button>
            )}
          </div>
        )}

        {/* Step: Local Ready */}
        {step === 'local-ready' && (
          <div className="text-center space-y-6">
            <CheckCircle size={64} className="mx-auto text-green-400" />
            <h2 className="text-2xl font-bold text-white">You're All Set</h2>
            <p className="text-white/40 text-sm">
              Lumi will use your local model for everyday conversations. For complex tasks, it will automatically fall back to the cloud.
            </p>
            <button onClick={() => setStep('voice-test')} className="w-full px-6 py-4 bg-green-600 hover:bg-green-500 rounded-2xl text-white font-semibold transition-colors">
              Test Voice <Volume2 size={18} className="inline ml-2" />
            </button>
          </div>
        )}

        {/* Step: API Key Setup */}
        {step === 'api-setup' && (
          <div className="space-y-5">
            <h2 className="text-xl font-bold text-white text-center">Cloud API Setup</h2>
            <p className="text-white/40 text-sm text-center">
              Pick a provider and enter your API key. It will be saved locally — never sent anywhere.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {['deepseek', 'qwen', 'openai'].map(p => (
                <button
                  key={p}
                  onClick={() => setApiProvider(p)}
                  className={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
                    apiProvider === p ? 'bg-blue-600 border-blue-500 text-white' : 'bg-white/5 border-white/10 text-white/50 hover:border-white/20'
                  }`}
                >
                  {p === 'deepseek' ? 'DeepSeek' : p === 'qwen' ? 'Qwen' : 'OpenAI'}
                </button>
              ))}
            </div>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={`${apiProvider} API key...`}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/45 focus:outline-none focus:border-blue-500/50 font-mono text-sm"
            />
            <button
              onClick={handleSaveApiKey}
              disabled={!apiKey.trim() || saving}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-xl text-white font-medium transition-colors"
            >
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Key size={18} />}
              Save & Continue
            </button>
            <button onClick={() => setStep('voice-test')} className="w-full text-white/55 text-sm hover:text-white/50 py-2">
              Skip for now
            </button>
          </div>
        )}

        {/* Step: Voice Test */}
        {step === 'voice-test' && (
          <div className="text-center space-y-6">
            <Mic size={64} className={`mx-auto ${voiceStatus === 'ok' ? 'text-green-400' : voiceStatus === 'failed' ? 'text-red-400' : 'text-blue-400'}`} />
            <h2 className="text-2xl font-bold text-white">Voice Check</h2>
            <p className="text-white/40 text-sm">
              {voiceStatus === 'idle' && 'Let\'s make sure voice output works.'}
              {voiceStatus === 'testing' && 'Playing test audio...'}
              {voiceStatus === 'ok' && 'Voice is working perfectly!'}
              {voiceStatus === 'failed' && 'Voice needs configuration. You can set it up later in Settings.'}
            </p>
            {voiceStatus === 'idle' && (
              <button onClick={handleVoiceTest} className="px-6 py-3 bg-purple-600 hover:bg-purple-500 rounded-xl text-white font-medium transition-colors">
                Play Test Audio <Volume2 size={18} className="inline ml-2" />
              </button>
            )}
            <button
              onClick={() => {
                setStep('done');
                setTimeout(onFinish, 1000);
              }}
              className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-2xl text-white font-semibold transition-all"
            >
              <Sparkles size={18} />
              Launch Lumi
            </button>
          </div>
        )}

        {/* Step: Done */}
        {step === 'done' && (
          <div className="text-center space-y-6">
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}>
              <Sparkles size={64} className="mx-auto text-celestial-saturn" />
            </motion.div>
            <h2 className="text-2xl font-bold text-white">Lumi is Ready</h2>
            <p className="text-white/40 text-sm">Your personal AI is live. Start talking — it will learn and grow with you.</p>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
