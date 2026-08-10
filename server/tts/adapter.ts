import { TTSConfig, TTSResult, TTSProvider, VoiceCloneRequest, VoiceListItem } from './types';
import * as gptsovits from './providers/gptsovits';
import * as cosyvoice from './providers/cosyvoice';
import * as ark from './providers/ark';
import { getKey } from '../config/keys';
import { hasDoubaoSpeech } from './providers/ark';
import { getVoicePreference } from '../config/voice_preference';
import { isCircuitClosed } from '../cloud/circuit_breaker';

export async function synthesizeSpeech(text: string, config: TTSConfig): Promise<TTSResult> {
  switch (config.provider) {
    case 'gptsovits':
      return gptsovits.synthesizeSpeech(text, config.voiceId, config.signal);
    case 'cosyvoice':
      return cosyvoice.synthesizeSpeech(text, config.voiceId, config.signal, config.speechRate, config.pitch, config.volume);
    case 'ark':
      return ark.synthesizeSpeech(text, config.voiceId, config.signal, config.speechRate, config.pitch, config.volume);
    default:
      throw new Error(`Unknown TTS provider: ${config.provider}`);
  }
}

export async function cloneVoice(request: VoiceCloneRequest, provider: TTSProvider): Promise<string> {
  switch (provider) {
    case 'cosyvoice':
      return cosyvoice.cloneVoice(request.sampleUrls, request.name);
    default:
      throw new Error(`Voice cloning not supported for provider: ${provider}`);
  }
}

export async function designVoice(prompt: string, name: string, provider: TTSProvider = 'cosyvoice'): Promise<string> {
  switch (provider) {
    case 'cosyvoice':
      return cosyvoice.designVoice(prompt, name);
    default:
      throw new Error(`Voice design not supported for provider: ${provider}`);
  }
}

export async function listVoices(provider: TTSProvider): Promise<VoiceListItem[]> {
  switch (provider) {
    case 'cosyvoice':
      return cosyvoice.listVoices();
    case 'gptsovits':
      return gptsovits.listVoices();
    case 'ark':
      return ark.listVoices();
    default:
      throw new Error(`Unknown TTS provider: ${provider}`);
  }
}

export function resolveVoiceTtsProvider(selection?: { provider?: string; voiceId?: string }): TTSProvider | null {
  // Always consult the DB-configured provider first — it represents the user's
  // explicit system preference (set in Settings → Voice Services). Frontend may
  // send a stale provider from localStorage (e.g. cosyvoice picked before the
  // user switched the backend to ark). DB preference wins unless it's "auto".
  const dbProvider = getActiveProvider();
  const pref = getVoicePreference();

  // If DB has an explicit provider preference (not auto), use it — frontend's
  // voiceProvider is just a hint from the voice picker and may be stale.
  if (pref.tts !== 'auto' && dbProvider) {
    return dbProvider;
  }

  // DB says "auto" — try the frontend's selection first, validated
  if (selection?.provider) {
    const normalized = selection.provider.toLowerCase();
    if (normalized === 'cosyvoice' || normalized === 'gptsovits' || normalized === 'ark') {
      // Validate the provider is actually available before using it
      if (normalized === 'ark' && !hasDoubaoSpeech()) {
        return dbProvider; // fall back to auto-detection
      }
      if (normalized === 'cosyvoice') {
        const dashscopeKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY');
        if (!dashscopeKey || !isCircuitClosed('qwen')) {
          return dbProvider; // fall back to auto-detection
        }
      }
      if (normalized === 'gptsovits') {
        if (!process.env.GPTSOVITS_API_URL && process.env.GPTSOVITS_ENABLED !== 'true') {
          return dbProvider; // fall back to auto-detection
        }
      }
      return normalized as TTSProvider;
    }
  }

  return dbProvider;
}

export function getActiveProvider(): TTSProvider | null {
  const pref = getVoicePreference();
  if (pref.tts === 'gptsovits' && (process.env.GPTSOVITS_API_URL || process.env.GPTSOVITS_ENABLED === 'true')) return 'gptsovits';
  if (pref.tts === 'cosyvoice') return 'cosyvoice';
  if (pref.tts === 'ark' && hasDoubaoSpeech()) return 'ark';
  // Auto mode — pick based on what's available, skip circuit-open providers
  if (hasDoubaoSpeech()) return 'ark';
  const dashscopeKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY');
  if (dashscopeKey && isCircuitClosed('qwen')) return 'cosyvoice';
  if (process.env.GPTSOVITS_API_URL || process.env.GPTSOVITS_ENABLED === 'true') return 'gptsovits';
  // Fallback: try anyway if nothing healthy
  if (dashscopeKey) return 'cosyvoice';
  return 'cosyvoice';
}

function clampVoiceParam(v: number, min = 0.8, max = 1.15): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 数字生命体·语音模块（第二阶段·阶段四）— 情绪/方向/关系 → 语音参数三重映射
 * 情绪决定"此刻的心情"（速度/音调基础层），方向决定"表达姿态"（坚定给予 vs 克制收敛），
 * 关系决定"亲密温度"（亲近阶段 → 更暖更近）。voiceId 永远保持用户所选 —
 * 状态改变的是 HOW to speak，不是 WHO is speaking。
 */
export function mapStateToVoiceParams(defaultVoiceId: string, params: {
  emotion?: { dominantMood?: string; arousal?: number; valence?: number; energy?: number };
  direction?: { inclination?: 'give' | 'not_give' | 'neutral' | 'unknown'; intensity?: number };
  relationship?: { stage?: string };
}): { voiceId: string; speechRate?: number; pitch?: number; volume?: number } {
  // 1. 情绪映射（基础层）：复用 resolveEmotionVoice 的 mood/arousal/valence → 参数
  const emo = resolveEmotionVoice(defaultVoiceId, params.emotion);
  const out: { voiceId: string; speechRate?: number; pitch?: number; volume?: number } = {
    voiceId: defaultVoiceId,
    speechRate: emo.speechRate,
    pitch: emo.pitch,
    volume: emo.volume,
  };

  // 2. 方向映射（表达姿态层）：inclination + intensity 决定坚定/收敛的幅度
  const inclination = params.direction?.inclination;
  const intensity = params.direction?.intensity ?? 0.5;
  if (inclination === 'give') {
    // 坚定给予：语速微升、音调微升、音量微升 — intensity 越大越明显
    out.pitch = clampVoiceParam((out.pitch ?? 1.0) + 0.06 * intensity * 2);
    out.volume = clampVoiceParam((out.volume ?? 1.0) + 0.05 * intensity * 2, 0.75, 1.15);
  } else if (inclination === 'not_give') {
    // 克制收敛：放缓、轻降音量
    out.speechRate = clampVoiceParam((out.speechRate ?? 1.0) - 0.05 * intensity * 2, 0.8, 1.2);
    out.volume = clampVoiceParam((out.volume ?? 1.0) - 0.04 * intensity * 2, 0.75, 1.15);
  }

  // 3. 关系映射（温度层）：亲近阶段 → 更暖（音调微升 + 音量微升）
  const stage = params.relationship?.stage;
  if (stage === 'intimate' || stage === 'close' || stage === 'family') {
    out.pitch = clampVoiceParam((out.pitch ?? 1.0) + 0.02);
    out.volume = clampVoiceParam((out.volume ?? 1.0) + 0.03, 0.75, 1.15);
  }

  return out;
}

/**
 * Map emotional state to speech parameters (speed/pitch/volume) while
 * preserving the user's chosen voiceId. Emotion should change HOW the
 * voice speaks, not WHO is speaking.
 */
export function resolveEmotionVoice(defaultVoiceId: string, emotionalState?: {
  dominantMood?: string;
  arousal?: number;
  valence?: number;
  energy?: number;
}): { voiceId: string; speechRate?: number; pitch?: number; volume?: number } {
  if (!emotionalState) return { voiceId: defaultVoiceId };

  const { dominantMood, arousal = 0.5, valence = 0, energy = 0.5 } = emotionalState;

  // Mood → speech parameters only (voiceId stays as user selected)
  if (dominantMood) {
    switch (dominantMood) {
      case 'excited':  return { voiceId: defaultVoiceId, speechRate: 1.15, pitch: 1.05 };
      case 'playful':  return { voiceId: defaultVoiceId, speechRate: 1.10, pitch: 1.03 };
      case 'tired':    return { voiceId: defaultVoiceId, speechRate: 0.85, pitch: 0.95 };
      case 'sad':      return { voiceId: defaultVoiceId, speechRate: 0.90, pitch: 0.90, volume: 0.85 };
      case 'calm':     return { voiceId: defaultVoiceId, speechRate: 0.95 };
      case 'focused':  return { voiceId: defaultVoiceId, speechRate: 1.05 };
      case 'warm':
      case 'affectionate':
      case 'contemplative':
      case 'curious':
        return { voiceId: defaultVoiceId };
    }
  }

  // Fallback: arousal + valence → speech parameters
  if (arousal > 0.7 && valence > 0.3)  return { voiceId: defaultVoiceId, speechRate: 1.10, pitch: 1.03 };
  if (arousal > 0.7 && valence < -0.2) return { voiceId: defaultVoiceId, speechRate: 1.12, pitch: 1.05 };
  if (arousal < 0.3 && valence > 0.2)  return { voiceId: defaultVoiceId, speechRate: 0.92 };
  if (arousal < 0.3 && valence < -0.2) return { voiceId: defaultVoiceId, speechRate: 0.88, volume: 0.85 };

  return { voiceId: defaultVoiceId };
}
