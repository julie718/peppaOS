import { TTSResult, VoiceListItem } from '../types';
import { getKey } from '../../config/keys';

const BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

function getApiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY');
  if (!key) throw new Error('DASHSCOPE_API_KEY is not configured. Add it in Settings → Voice Services.');
  return key;
}

const PRESET_VOICES: VoiceListItem[] = [
  { voiceId: 'longxiaochun_v3', name: 'Long Xiaochun - bright female', category: 'premade', language: 'zh' },
  { voiceId: 'longxiaoxia_v3', name: 'Long Xiaoxia - calm female', category: 'premade', language: 'zh' },
  { voiceId: 'longyumi_v3', name: 'YUMI - youthful female', category: 'premade', language: 'zh' },
  { voiceId: 'longanyun_v3', name: 'Long Anyun - warm male', category: 'premade', language: 'zh' },
  { voiceId: 'longanwen_v3', name: 'Long Anwen - elegant female', category: 'premade', language: 'zh' },
  { voiceId: 'longanli_v3', name: 'Long Anli - composed female', category: 'premade', language: 'zh' },
  { voiceId: 'longanlang_v3', name: 'Long Anlang - clear male', category: 'premade', language: 'zh' },
  { voiceId: 'longyingmu_v3', name: 'Long Yingmu - refined female', category: 'premade', language: 'zh' },
  { voiceId: 'longanyang', name: 'Long Anyang - sunny male', category: 'premade', language: 'zh' },
  { voiceId: 'longanhuan', name: 'Long Anhuan - upbeat female', category: 'premade', language: 'zh' },
  { voiceId: 'longhua_v3', name: 'Long Hua - sweet female', category: 'premade', language: 'zh' },
  { voiceId: 'longcheng_v3', name: 'Long Cheng - smart male', category: 'premade', language: 'zh' },
  { voiceId: 'longze_v3', name: 'Long Ze - warm male', category: 'premade', language: 'zh' },
  { voiceId: 'longxing_v3', name: 'Long Xing - gentle female', category: 'premade', language: 'zh' },
  { voiceId: 'longtian_v3', name: 'Long Tian - rational male', category: 'premade', language: 'zh' },
  { voiceId: 'longwan_v3', name: 'Long Wan - soft female', category: 'premade', language: 'zh' },
  { voiceId: 'longanya_v3', name: 'Long Anya - graceful female', category: 'premade', language: 'zh' },
  { voiceId: 'longanqin_v3', name: 'Long Anqin - friendly female', category: 'premade', language: 'zh' },
  { voiceId: 'longanrou_v3', name: 'Long Anrou - tender female', category: 'premade', language: 'zh' },
  { voiceId: 'longhan_v3', name: 'Long Han - affectionate male', category: 'premade', language: 'zh' },
  { voiceId: 'loongkyong_v3', name: 'Kyong - Korean female', category: 'premade', language: 'ko' },
  { voiceId: 'loongriko_v3', name: 'Riko - Japanese female', category: 'premade', language: 'ja' },
  { voiceId: 'loongtomoka_v3', name: 'Tomoka - Japanese female', category: 'premade', language: 'ja' },
  { voiceId: 'longjiaxin_v3', name: 'Long Jiaxin - Cantonese female', category: 'premade', language: 'yue' },
  { voiceId: 'longlaotie_v3', name: 'Long Laotie - Northeastern male', category: 'premade', language: 'zh' },
];

export async function synthesizeSpeech(
  text: string,
  voiceId: string = 'longxiaochun_v3',
  signal?: AbortSignal,
): Promise<TTSResult> {
  const apiKey = getApiKey();

  const body = {
    model: 'cosyvoice-v3-flash',
    input: {
      text,
      voice: voiceId,
      format: 'mp3',
      sample_rate: 22050,
    },
  };

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`CosyVoice TTS error (${res.status}): ${err.message || err.code || 'Unknown'}`);
  }

  const json = await res.json();
  const audioUrl = json.output?.audio?.url;
  if (!audioUrl) {
    throw new Error(`CosyVoice response missing audio URL: ${JSON.stringify(json)}`);
  }

  const audioRes = await fetch(audioUrl, { signal });
  if (!audioRes.ok) {
    throw new Error(`CosyVoice audio download failed (${audioRes.status})`);
  }

  const arrayBuffer = await audioRes.arrayBuffer();
  return {
    audioBuffer: Buffer.from(arrayBuffer),
    format: 'audio/mp3',
  };
}

export async function listVoices(): Promise<VoiceListItem[]> {
  return PRESET_VOICES;
}
