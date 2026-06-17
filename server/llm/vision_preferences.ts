import { readDB } from '../../db_layer';

export type VisionProvider = 'openai' | 'gemini' | 'ark' | 'qwen';

export interface VisionPrefs {
  provider: VisionProvider;
  model: string;
  models: Record<string, string>;
}

export const DEFAULT_VISION_MODELS: Record<VisionProvider, string> = {
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  ark: 'doubao-1-5-vision-pro-32k',
  qwen: 'qwen-vl-max',
};

const VALID_VISION_PROVIDERS = new Set<VisionProvider>(['openai', 'gemini', 'ark', 'qwen']);

function normalizeVisionProvider(value: unknown): VisionProvider {
  return typeof value === 'string' && VALID_VISION_PROVIDERS.has(value as VisionProvider)
    ? value as VisionProvider
    : 'openai';
}

export function getUserPreferredVision(userId: string): VisionPrefs {
  let raw: any = null;
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === `vision_prefs_${userId}`);
    if (setting?.value) raw = JSON.parse(setting.value);
  } catch {}

  const provider = normalizeVisionProvider(raw?.provider);
  const models = raw?.models && typeof raw.models === 'object' ? raw.models : {};
  const model = models[provider] || raw?.model || DEFAULT_VISION_MODELS[provider];

  return { provider, model, models };
}

export function getUserPreferredVisionConfig(
  userId: string,
  options: { maxTokens?: number } = {},
): { provider: VisionProvider; model: string; maxTokens?: number; userId: string } {
  const pref = getUserPreferredVision(userId);
  return {
    provider: pref.provider,
    model: pref.model,
    userId,
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
  };
}
