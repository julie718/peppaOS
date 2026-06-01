// Voice provider preference — shared by STT + TTS adapters.
// Persisted per-instance in db.settings. No user-id granularity needed
// since this is a system-level config.
import { readDB, writeDB } from '../../db_layer';

export interface VoicePreference {
  stt: 'auto' | 'local-whisper' | 'qwen' | 'deepgram' | 'whisper';
  tts: 'auto' | 'gptsovits' | 'cosyvoice';
}

const DEFAULT: VoicePreference = { stt: 'auto', tts: 'auto' };

export function getVoicePreference(): VoicePreference {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === 'voice_preference');
    if (setting) return { ...DEFAULT, ...JSON.parse(setting.value) };
  } catch {}
  return { ...DEFAULT };
}

export function setVoicePreference(pref: Partial<VoicePreference>): VoicePreference {
  const current = getVoicePreference();
  const merged = { ...current, ...pref };
  try {
    const db = readDB();
    if (!db.settings) db.settings = [];
    const idx = db.settings.findIndex((s: any) => s.key === 'voice_preference');
    if (idx >= 0) {
      db.settings[idx].value = JSON.stringify(merged);
    } else {
      db.settings.push({ key: 'voice_preference', value: JSON.stringify(merged) });
    }
    writeDB(db);
  } catch {}
  return merged;
}
