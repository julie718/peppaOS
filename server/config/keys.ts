import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDataPath } from './data_path';

const KEYS_FILE = getDataPath('keys.json');

// P1-5：密钥逐次读取 process.env（不缓存模块级常量）。生产行为与缓存一致
//（env 在进程启动前注入）；运行时读取使测试可注入/撤销 key，也避免 .env 变更后
// 进程内仍持旧密钥的隐患。
function getEncryptionKey(): Buffer | null {
  const encKeyHex = process.env.OXOG_ENV_KEY || '';
  if (!encKeyHex || encKeyHex.length !== 64) return null;
  return Buffer.from(encKeyHex, 'hex');
}

// P1-5 摒弃明文密钥配置：OXOG_ENV_KEY 缺失时禁止写入明文。
// 原实现 encrypt() 在无 key 时直接返回原文 → keys.json 以明文落盘（仓库/备份泄露面）。
// 现在无 key 返回 null，saveKeys 拒绝写入并抛错；loadKeys 对既有明文仅做迁移
// 并给出醒目警告（读兼容 + 强制加密写入）。
function encrypt(plaintext: string): string | null {
  const key = getEncryptionKey();
  if (!key) return null; // P1-5: no key → refuse（不再降级为明文）
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

let warnedMissingEnvKey = false;

/** P1-5：OXOG_ENV_KEY 缺失警告（仅一次，避免 getKey 高频调用刷屏） */
function warnMissingEnvKey(): void {
  if (warnedMissingEnvKey) return;
  warnedMissingEnvKey = true;
  console.warn(
    '[Keys] ⚠️ OXOG_ENV_KEY 未配置（64位hex）— 密钥保存已被拒绝（摒弃明文密钥配置）。' +
    '生成密钥: openssl rand -hex 32；部署通过 .env 的 OXOG_ENV_KEY 注入（docker-compose 透传）。',
  );
}

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
        const encrypted = encrypt(raw);
        if (encrypted) fs.writeFileSync(KEYS_FILE, encrypted);
      } else {
        // P1-5：明文文件 + 无加密 key → 读取兼容但醒目警告（写入路径已严格拒绝）
        warnMissingEnvKey();
      }
      return keys;
    }
  } catch {}
  if (!getEncryptionKey()) warnMissingEnvKey();
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
  // P1-5 摒弃明文密钥配置：无 OXOG_ENV_KEY 时拒绝写入（原实现 encrypt 无 key 返回原文 → 明文落盘）
  if (!getEncryptionKey()) {
    warnMissingEnvKey();
    throw new Error(
      'OXOG_ENV_KEY 未配置（64位hex），密钥存储已禁用明文，拒绝写入 keys.json。' +
      '请先设置 OXOG_ENV_KEY（生成: openssl rand -hex 32）再保存密钥。',
    );
  }
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
  const encrypted = encrypt(payload);
  if (!encrypted) {
    throw new Error('密钥加密失败（OXOG_ENV_KEY 无效），拒绝明文写入 keys.json');
  }
  fs.writeFileSync(KEYS_FILE, encrypted);

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
