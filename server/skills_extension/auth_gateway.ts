// 阶段三·模块4 — 独立授权网关（AES-256-GCM 密钥加密 + 限流 + 计费统计）
//
// 安全红线（本模块强制）：
//   1. 第三方密钥使用 AES-256-GCM 加密落库（格式 base64:iv:tag:ciphertext），明文仅在本模块内存中存在；
//   2. 心智层不可读明文：对外只暴露 proxyFetch（网关解密后亲自代理请求），任何上层不接触密钥明文；
//   3. 限流：每服务独立令牌桶，超限拒绝并审计；
//   4. 计费统计：调用计数 + 预估成本（按候选估算成本/千次），供前端面板；
//   5. 日志/审计永不打印密钥片段（含掩码）——仅记录 serviceName 与长度。
//
// 主密钥：GATEWAY_MASTER_KEY（32 字节 hex/base64 或任意字符串经 SHA-256 派生），
//         未配置时由 JWT_SECRET 派生（部署零额外配置）。

import * as crypto from 'crypto';
import { logger } from '../lib/logger';
import { appendAudit, deleteCredential, getCredentialByService, listCredentials, upsertCredential } from './database';

// ── 主密钥派生 ──

let masterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (masterKey) return masterKey;
  const raw = process.env.GATEWAY_MASTER_KEY || process.env.JWT_SECRET || 'MayOS2024Secret';
  // 任意字符串经 SHA-256 派生 32 字节密钥；或直接接受 64 位 hex
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    masterKey = Buffer.from(raw, 'hex');
  } else {
    masterKey = crypto.createHash('sha256').update(raw).digest();
  }
  return masterKey;
}

// ── AES-256-GCM 加解密 ──

/** 加密：base64(iv):base64(tag):base64(ciphertext) */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** 解密（格式错误/密钥错误 → 抛错，不静默返回） */
export function decryptSecret(ciphertext: string): string {
  const [ivB64, tagB64, encB64] = ciphertext.split(':');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('密文格式错误（期望 base64:iv:tag:ciphertext）');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
  return plain.toString('utf-8');
}

// ── 凭证管理（前端密钥录入/删除） ──

export async function setCredential(serviceName: string, plaintext: string, userId = '', boundTools = ''): Promise<void> {
  if (!plaintext || plaintext.length < 4) throw new Error('密钥长度过短（至少 4 字符）');
  const encrypted = encryptSecret(plaintext);
  await upsertCredential({ serviceName, encryptedKey: encrypted, boundTools, enabled: 1, userId });
  // 审计只记录长度，绝不打印任何密钥片段
  await appendAudit('credential_set', serviceName, `密钥已更新（长度 ${plaintext.length}，已 AES-256-GCM 加密）`);
  logger.info(`[SkillsAuth] 凭证已更新: ${serviceName}（长度 ${plaintext.length}）`);
}

export async function removeCredential(serviceName: string): Promise<boolean> {
  const exists = await getCredentialByService(serviceName);
  if (!exists) return false;
  await deleteCredential(serviceName);
  await appendAudit('credential_delete', serviceName, '凭证已删除');
  return true;
}

/** 列表（永不含密文与片段） */
export async function listCredentialMeta(): Promise<Array<{ serviceName: string; boundTools: string; enabled: boolean; createdAt: string; updatedAt: string }>> {
  const all = await listCredentials();
  return all.map(c => ({
    serviceName: c.serviceName,
    boundTools: c.boundTools,
    enabled: !!c.enabled,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
}

export async function hasCredential(serviceName: string): Promise<boolean> {
  const c = await getCredentialByService(serviceName);
  return !!c && !!c.enabled;
}

// ── 限流（每服务令牌桶） ──

interface Bucket { tokens: number; lastRefill: number; }
const buckets = new Map<string, Bucket>();
export const RATE_LIMIT_PER_MIN = Number(process.env.SKILLS_GATEWAY_RATE_PER_MIN || 60);

function consumeToken(serviceName: string): boolean {
  const now = Date.now();
  let b = buckets.get(serviceName);
  if (!b) { b = { tokens: RATE_LIMIT_PER_MIN, lastRefill: now }; buckets.set(serviceName, b); }
  const elapsed = now - b.lastRefill;
  if (elapsed >= 60_000) {
    b.tokens = RATE_LIMIT_PER_MIN;
    b.lastRefill = now;
  }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

// ── 计费统计（内存计数 + 预估成本；成本由审批时登记的估算单价决定） ──

interface BillingEntry { calls: number; costPer1k: number; }
const billing = new Map<string, BillingEntry>();

/** 登记工具估算成本（元/千次）——审批上线时由候选信息注入 */
export function setEstimatedCost(serviceName: string, costPer1k: number): void {
  const b = billing.get(serviceName) || { calls: 0, costPer1k: 0 };
  b.costPer1k = costPer1k;
  billing.set(serviceName, b);
}

export function getBillingStats(): Array<{ serviceName: string; calls: number; costEstimate: number }> {
  return Array.from(billing.entries()).map(([serviceName, b]) => ({
    serviceName,
    calls: b.calls,
    costEstimate: Math.round(b.calls / 1000 * b.costPer1k * 100) / 100,
  }));
}

// ── 授权代理（明文密钥仅在此使用，向外只暴露 Response） ──

export type GatewayAuthInjector = (credential: string) => Record<string, string>;

/** 各服务的认证头注入器（按 serviceName 注册；默认 Bearer 模式） */
const authInjectors = new Map<string, GatewayAuthInjector>();
export function registerAuthInjector(serviceName: string, injector: GatewayAuthInjector): void {
  authInjectors.set(serviceName, injector);
}

export function getAuthInjector(serviceName: string): GatewayAuthInjector | undefined {
  return authInjectors.get(serviceName);
}

/**
 * 网关代理请求：解密密钥 → 注入认证头 → 限流 → 发起请求 → 计费。
 * 密钥明文不离开本函数作用域。适配器通过 setProxyFetcher(proxyFetch) 接入。
 */
export async function proxyFetch(serviceName: string, url: string, init: RequestInit): Promise<Response> {
  const cred = await getCredentialByService(serviceName);
  if (!cred || !cred.enabled) {
    await appendAudit('api_call', serviceName, '拒绝：未授权凭证');
    throw new Error(`服务 ${serviceName} 未授权，请先在密钥管理中录入密钥`);
  }
  if (!consumeToken(serviceName)) {
    await appendAudit('api_call', serviceName, `拒绝：限流（>${RATE_LIMIT_PER_MIN}/min）`);
    throw new Error(`服务 ${serviceName} 请求过于频繁（限流 ${RATE_LIMIT_PER_MIN}/min），请稍后重试`);
  }

  let plain: string;
  try {
    plain = decryptSecret(cred.encryptedKey);
  } catch (e: any) {
    await appendAudit('api_call', serviceName, `拒绝：密钥解密失败（${e.message}）`);
    throw new Error(`服务 ${serviceName} 密钥解密失败，请重新录入`);
  }

  const headers = new Headers(init.headers || {});
  const injector = authInjectors.get(serviceName);
  const injected = injector ? injector(plain) : { Authorization: `Bearer ${plain}` };
  for (const [k, v] of Object.entries(injected)) headers.set(k, v);

  const b = billing.get(serviceName) || { calls: 0, costPer1k: 0 };
  b.calls += 1;
  billing.set(serviceName, b);

  try {
    return await fetch(url, { ...init, headers });
  } catch (e) {
    await appendAudit('api_call', serviceName, `外部请求失败: ${(e as Error).message}`);
    throw e;
  }
}
