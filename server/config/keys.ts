import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDataPath } from './data_path';

const KEYS_FILE = getDataPath('keys.json');
const ENC_KEY_HEX = process.env.OXOG_ENV_KEY || '';

function getEncryptionKey(): Buffer | null {
  if (!ENC_KEY_HEX || ENC_KEY_HEX.length !== 64) return null;
  return Buffer.from(ENC_KEY_HEX, 'hex');
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext; // no key configured, skip encryption
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(payload: string): string | null {
  const key = getEncryptionKey();
  if (!key) return null;
  try {
    const parts = payload.split(':');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface KeyStore {
  [key: string]: string | undefined;
  DEEPGRAM_API_KEY?: string;
  PICOVOICE_ACCESS_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  QWEN_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  E2B_API_KEY?: string;
  ARK_API_KEY?: string;
  DOUBAO_SPEECH_KEY?: string;
  NETEASE_APP_ID?: string;
  NETEASE_PRIVATE_KEY?: string;
  ALIYUN_AK_ID?: string;
  ALIYUN_AK_SECRET?: string;
  SILICONFLOW_API_KEY?: string;
  XIAOMI_API_KEY?: string;
  KIMI_API_KEY?: string;
  GLM_API_KEY?: string;
  RELAY_API_KEY?: string;
  RELAY_BASE_URL?: string;
  QICHACHA_API_KEY?: string;
  QICHACHA_APP_KEY?: string;
  QICHACHA_SECRET_KEY?: string;
  QICHACHA_BASE_URL?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
  WECHAT_BOT_TOKEN?: string;
  WECHAT_BOT_ID?: string;
  WECHAT_BASE_URL?: string;
  GITHUB_TOKEN?: string;
  NOTION_API_KEY?: string;
  FIGMA_ACCESS_TOKEN?: string;
}

/** Which circuit-breaker provider(s) a given key name affects */
const KEY_TO_CIRCUIT: Partial<Record<keyof KeyStore, string[]>> = {
  DASHSCOPE_API_KEY: ['qwen'],
  QWEN_API_KEY: ['qwen'],
  DEEPGRAM_API_KEY: ['deepgram'],
  OPENAI_API_KEY: ['openai'],
  ANTHROPIC_API_KEY: ['anthropic'],
  GEMINI_API_KEY: ['gemini'],
  DEEPSEEK_API_KEY: ['deepseek'],
};

export function loadKeys(): KeyStore {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const raw = fs.readFileSync(KEYS_FILE, 'utf-8');
      // Try decrypt first (encrypted format: IV:AUTH_TAG:CIPHERTEXT)
      const decrypted = decrypt(raw);
      if (decrypted !== null) return JSON.parse(decrypted);
      // Plaintext — migrate to encrypted on the fly
      const keys = JSON.parse(raw);
      if (getEncryptionKey()) {
        fs.writeFileSync(KEYS_FILE, encrypt(raw));
      }
      return keys;
    }
  } catch {}
  return {};
}

const BUILTIN_KEY_NAMES = [
  'DEEPGRAM_API_KEY',
  'PICOVOICE_ACCESS_KEY',
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'QWEN_API_KEY',
  'MINIMAX_API_KEY',
  'E2B_API_KEY',
  'ARK_API_KEY',
  'DOUBAO_SPEECH_KEY',
  'NETEASE_APP_ID',
  'NETEASE_PRIVATE_KEY',
  'ALIYUN_AK_ID',
  'ALIYUN_AK_SECRET',
  'SILICONFLOW_API_KEY',
  'XIAOMI_API_KEY',
  'KIMI_API_KEY',
  'GLM_API_KEY',
  'RELAY_API_KEY',
  'RELAY_BASE_URL',
  'QICHACHA_API_KEY',
  'QICHACHA_APP_KEY',
  'QICHACHA_SECRET_KEY',
  'QICHACHA_BASE_URL',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_VERIFICATION_TOKEN',
  'WECHAT_BOT_TOKEN',
  'WECHAT_BOT_ID',
  'WECHAT_BASE_URL',
  'GITHUB_TOKEN',
  'NOTION_API_KEY',
  'FIGMA_ACCESS_TOKEN',
] as const;

const BLOCKED_CUSTOM_KEY_NAMES = new Set([
  'PATH',
  'PATHEXT',
  'NODE_OPTIONS',
  'NODE_ENV',
  'PORT',
  'HOST',
  'JWT_SECRET',
  'LUMI_DATA_DIR',
]);

const SAFE_CUSTOM_KEY_NAME = /^[A-Z][A-Z0-9_]{2,80}$/;
const SAFE_CUSTOM_SECRET_NAME = /(?:_API_KEY|_TOKEN|_SECRET|_APP_ID|_PRIVATE_KEY|_BASE_URL|_ACCESS_KEY|_AK_ID|_AK_SECRET|_BOT_ID|_CLIENT_ID|_CLIENT_SECRET|_WEBHOOK_URL)$/;

export function isPersistableKeyName(name: string): boolean {
  if ((BUILTIN_KEY_NAMES as readonly string[]).includes(name)) return true;
  if (!SAFE_CUSTOM_KEY_NAME.test(name)) return false;
  if (BLOCKED_CUSTOM_KEY_NAMES.has(name)) return false;
  return SAFE_CUSTOM_SECRET_NAME.test(name);
}

export function saveKeys(keys: Partial<KeyStore>): void {
  const dir = path.dirname(KEYS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = loadKeys();
  const merged = { ...existing, ...keys };
  for (const [k, v] of Object.entries(merged)) {
    if (!v || (typeof v === 'string' && v.trim().length === 0)) {
      delete (merged as Record<string, unknown>)[k];
    }
  }
  const payload = JSON.stringify(merged, null, 2);
  fs.writeFileSync(KEYS_FILE, encrypt(payload));

  for (const [key, value] of Object.entries(keys)) {
    if (value && typeof value === 'string' && value.trim().length > 0) {
      process.env[key] = value.trim();
    } else {
      delete process.env[key];
    }
  }

  // Reset circuit breakers for affected providers so updated keys take effect immediately
  try {
    const { resetCircuit } = require('../cloud/circuit_breaker');
    for (const keyName of Object.keys(keys)) {
      const circuits = KEY_TO_CIRCUIT[keyName as keyof KeyStore];
      if (circuits) {
        for (const c of circuits) {
          resetCircuit(c);
        }
      }
    }
  } catch {}
}

export function getKey(name: keyof KeyStore): string | undefined {
  const keys = loadKeys();
  return keys[name];
}

export function getAllKeyNames(): string[] {
  const names = new Set<string>(BUILTIN_KEY_NAMES);
  const stored = loadKeys();
  for (const name of Object.keys(stored)) {
    if (isPersistableKeyName(name)) names.add(name);
  }
  return [...names];
}
