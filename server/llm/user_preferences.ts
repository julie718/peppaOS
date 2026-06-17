import { readDB } from '../../db_layer';

export type UserLLMProvider =
  | 'deepseek'
  | 'qwen'
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | 'ark'
  | 'xiaomi'
  | 'kimi'
  | 'glm'
  | 'relay'
  | 'ollama'
  | 'lmstudio'
  | 'auto';

export interface UserLLMPrefs {
  provider: UserLLMProvider;
  model: string;
  models: Record<string, string>;
}

const DEFAULT_MODELS: Record<UserLLMProvider, string> = {
  deepseek: 'deepseek-chat',
  qwen: 'qwen-plus',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-6',
  ark: 'doubao-1-5-pro-32k',
  xiaomi: 'xiaomi-chat',
  kimi: 'moonshot-v1-8k',
  glm: 'glm-4-plus',
  relay: 'gpt-4o',
  ollama: 'qwen2.5:7b',
  lmstudio: 'local-model',
  auto: 'qwen2.5:7b',
};

const VALID_PROVIDERS = new Set<UserLLMProvider>([
  'deepseek',
  'qwen',
  'openai',
  'gemini',
  'anthropic',
  'ark',
  'xiaomi',
  'kimi',
  'glm',
  'relay',
  'ollama',
  'lmstudio',
  'auto',
]);

function normalizeProvider(value: unknown): UserLLMProvider {
  return typeof value === 'string' && VALID_PROVIDERS.has(value as UserLLMProvider)
    ? value as UserLLMProvider
    : 'deepseek';
}

export function getUserPreferredLLM(userId: string): UserLLMPrefs {
  let raw: any = null;
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === `llm_prefs_${userId}`);
    if (setting?.value) raw = JSON.parse(setting.value);
  } catch {}

  const provider = normalizeProvider(raw?.provider);
  const models = raw?.models && typeof raw.models === 'object' ? raw.models : {};
  const model = models[provider] || DEFAULT_MODELS[provider];

  return { provider, model, models };
}

export function getUserPreferredLLMConfig(
  userId: string,
  options: { maxTokens?: number } = {},
): { provider: UserLLMProvider; model: string; userId: string; maxTokens?: number } {
  const pref = getUserPreferredLLM(userId);
  return {
    provider: pref.provider,
    model: pref.model,
    userId,
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
  };
}
