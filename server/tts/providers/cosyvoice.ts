import { TTSResult, VoiceListItem } from '../types';

const BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/speech';

function getApiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
  if (!key) throw new Error('DASHSCOPE_API_KEY or QWEN_API_KEY is not configured');
  return key;
}

const PRESET_VOICES: VoiceListItem[] = [
  { voiceId: 'longxiaochun', name: 'Long Xiaochun', category: 'premade', language: 'zh' },
  { voiceId: 'longxiaoxia', name: 'Long Xiaoxia', category: 'premade', language: 'zh' },
  { voiceId: 'longxiaobai', name: 'Long Xiaobai', category: 'premade', language: 'zh' },
  { voiceId: 'longxiaocheng', name: 'Long Xiaocheng', category: 'premade', language: 'zh' },
  { voiceId: 'longxiaofei', name: 'Long Xiaofei', category: 'premade', language: 'zh' },
  { voiceId: 'longlaocheng', name: 'Long Laocheng', category: 'premade', language: 'zh' },
  { voiceId: 'longyichen', name: 'Long Yichen', category: 'premade', language: 'zh' },
  { voiceId: 'longshiqiao', name: 'Long Shiqiao', category: 'premade', language: 'zh' },
  { voiceId: 'longwanqing', name: 'Long Wanqing', category: 'premade', language: 'zh' },
  { voiceId: 'longchengxi', name: 'Long Chengxi', category: 'premade', language: 'zh' },
  { voiceId: 'longyue', name: 'Long Yue', category: 'premade', language: 'zh' },
  { voiceId: 'longhua', name: 'Long Hua', category: 'premade', language: 'zh' },
  { voiceId: 'loongstacey', name: 'Stacey', category: 'premade', language: 'en' },
  { voiceId: 'loongbella', name: 'Bella', category: 'premade', language: 'en' },
  { voiceId: 'loongkobe', name: 'Kobe', category: 'premade', language: 'en' },
];

export async function synthesizeSpeech(
  text: string,
  voiceId: string = 'longxiaochun',
  signal?: AbortSignal,
): Promise<TTSResult> {
  const apiKey = getApiKey();

  const body = {
    model: 'cosyvoice-v1',
    input: { text },
    parameters: {
      voice: voiceId,
      format: 'mp3',
      sample_rate: 22050,
    },
  };

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`CosyVoice TTS error (${res.status}): ${err.message || err.code || 'Unknown'}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    audioBuffer: Buffer.from(arrayBuffer),
    format: 'audio/mp3',
  };
}

export async function listVoices(): Promise<VoiceListItem[]> {
  return PRESET_VOICES;
}
