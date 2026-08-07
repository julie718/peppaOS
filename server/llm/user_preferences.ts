import { readDB, writeDB } from '../../db_layer';

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
  source?: 'personal' | 'organization';
  inheritPersonal?: boolean;
}

export const DEFAULT_MODELS: Record<UserLLMProvider, string> = {
  deepseek: 'deepseek-v4-flash',
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

// O-1: 复杂任务高档位模型映射 — chat/voice/task 的场景分层路由统一从这里读取，
// 修复前四处直写 'deepseek-v4-pro'，模型档位变更需改多处且易遗漏
export const COMPLEX_MODELS: Record<UserLLMProvider, string> = {
  deepseek: 'deepseek-v4-pro',
  qwen: 'qwen-max',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  anthropic: 'claude-opus-5',
  ark: 'doubao-1-5-pro-32k',
  xiaomi: 'xiaomi-chat',
  kimi: 'moonshot-v1-8k',
  glm: 'glm-4-plus',
  relay: 'gpt-4o',
  ollama: 'qwen2.5:7b',
  lmstudio: 'local-model',
  auto: 'qwen2.5:7b',
};

/**
 * P1-3: 场景分层模型路由 — 同一 provider 下按场景选更轻/更强的模型。
 * light（问候/闲聊/摘要）：选轻量模型；complex（复杂推理/长任务）：选重模型；
 * standard（默认）：保持用户配置的主模型。未映射的 provider 回退主模型。
 */
export type LLMScenario = 'light' | 'standard' | 'complex';

const SCENARIO_MODELS: Record<LLMScenario, Partial<Record<UserLLMProvider, string>>> = {
  light: {
    deepseek: 'deepseek-v4-flash',
    qwen: 'qwen-turbo',
    openai: 'gpt-4o-mini',
    gemini: 'gemini-2.0-flash',
    anthropic: 'claude-haiku-4-5-20251001',
    ark: 'doubao-lite-4k',
    kimi: 'moonshot-v1-8k',
    glm: 'glm-4-flash',
    relay: 'gpt-4o-mini',
  },
  standard: {},
  complex: {
    deepseek: 'deepseek-chat',
    qwen: 'qwen-max',
    openai: 'gpt-4o',
    gemini: 'gemini-2.5-pro',
    anthropic: 'claude-sonnet-4-6',
    ark: 'doubao-1-5-pro-32k',
    kimi: 'moonshot-v1-128k',
    glm: 'glm-4-plus',
    relay: 'gpt-4o',
  },
};

/** 取某 provider 在某场景下的模型名（未映射/standard → 主模型） */
export function getScenarioModel(provider: UserLLMProvider, scenario: LLMScenario = 'standard'): string {
  if (scenario === 'standard') return DEFAULT_MODELS[provider];
  return SCENARIO_MODELS[scenario][provider] || DEFAULT_MODELS[provider];
}

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

function parsePrefsRow(key: string): any {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === key);
    if (setting?.value) return JSON.parse(setting.value);
  } catch {}
  return null;
}

function resolvePrefs(raw: any, source: 'personal' | 'organization'): UserLLMPrefs {
  const provider = normalizeProvider(raw?.provider);
  const models = raw?.models && typeof raw.models === 'object' ? raw.models : {};
  const model = models[provider] || DEFAULT_MODELS[provider];
  return {
    provider,
    model,
    models,
    source,
    inheritPersonal: raw?.inheritPersonal === true,
  };
}

export function getUserPreferredLLM(userId: string): UserLLMPrefs {
  return resolvePrefs(parsePrefsRow(`llm_prefs_${userId}`), 'personal');
}

export function getOrgPreferredLLM(orgId: string): (UserLLMPrefs & { configured: boolean }) | null {
  if (!orgId) return null;
  const raw = parsePrefsRow(`org_llm_prefs_${orgId}`);
  if (!raw) return null;
  if (raw.inheritPersonal === true || !raw.provider) {
    return { ...resolvePrefs(raw, 'organization'), configured: false, inheritPersonal: true };
  }
  return { ...resolvePrefs(raw, 'organization'), configured: true, inheritPersonal: false };
}

export function getScopedPreferredLLM(
  userId: string,
  scope: { domain?: string; orgId?: string } = {},
): UserLLMPrefs {
  if (scope.domain === 'work' && scope.orgId) {
    const orgPrefs = getOrgPreferredLLM(scope.orgId);
    if (orgPrefs?.configured) return orgPrefs;
  }
  return getUserPreferredLLM(userId);
}

export function upsertOrgPreferredLLM(
  orgId: string,
  input: { inheritPersonal?: boolean; provider?: string; models?: Record<string, string> },
): UserLLMPrefs & { configured: boolean } {
  if (!orgId) throw new Error('orgId is required');
  const inheritPersonal = input.inheritPersonal === true;
  const provider = inheritPersonal ? '' : normalizeProvider(input.provider);
  const models = !inheritPersonal && input.models && typeof input.models === 'object' ? input.models : {};
  const payload = {
    inheritPersonal,
    provider,
    models,
    updatedAt: new Date().toISOString(),
  };
  const db = readDB();
  const key = `org_llm_prefs_${orgId}`;
  if (!db.settings) (db as any).settings = [];
  const idx = (db.settings || []).findIndex((s: any) => s.key === key);
  if (idx >= 0) {
    (db.settings as any[])[idx].value = JSON.stringify(payload);
  } else {
    db.settings.push({ key, value: JSON.stringify(payload) });
  }
  writeDB(db);
  return inheritPersonal
    ? { ...resolvePrefs(payload, 'organization'), configured: false, inheritPersonal: true }
    : { ...resolvePrefs(payload, 'organization'), configured: true, inheritPersonal: false };
}

export function getUserPreferredLLMConfig(
  userId: string,
  options: { maxTokens?: number; domain?: string; orgId?: string; scenario?: LLMScenario } = {},
): { provider: UserLLMProvider; model: string; userId: string; maxTokens?: number; domain?: string; orgId?: string } {
  const pref = getScopedPreferredLLM(userId, { domain: options.domain, orgId: options.orgId });
  return {
    provider: pref.provider,
    // P1-3: 场景分层 — light/complex 场景按映射选更轻/更强的模型；standard 保持用户配置
    model: options.scenario ? getScenarioModel(pref.provider, options.scenario) : pref.model,
    userId,
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.orgId ? { orgId: options.orgId } : {}),
  };
}
