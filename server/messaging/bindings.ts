import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDataPath } from '../config/data_path';
import { getMember, getOrgById, listUserOrgs } from '../org/db';

export type MessagingPlatformId = 'feishu' | 'wechat' | 'wecom';

export interface MessagingBinding {
  id: string;
  platform: MessagingPlatformId;
  platformUserId: string;
  peppaUserId: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
}

interface BindingCode {
  code: string;
  platform: MessagingPlatformId;
  peppaUserId: string;
  orgId: string;
  expiresAt: string;
  createdAt: string;
}

interface StoreShape {
  bindings: MessagingBinding[];
  codes: BindingCode[];
}

const STORE_PATH = getDataPath(path.join('messaging', 'bindings.json'));

function now() {
  return new Date().toISOString();
}

function readStore(): StoreShape {
  try {
    if (!fs.existsSync(STORE_PATH)) return { bindings: [], codes: [] };
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      bindings: Array.isArray(parsed?.bindings) ? parsed.bindings : [],
      codes: Array.isArray(parsed?.codes) ? parsed.codes : [],
    };
  } catch {
    return { bindings: [], codes: [] };
  }
}

function writeStore(store: StoreShape) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function pruneExpiredCodes(store: StoreShape) {
  const ts = now();
  store.codes = store.codes.filter(item => item.expiresAt > ts);
}

export function createBindingCode(platform: MessagingPlatformId, peppaUserId: string, orgId = ''): BindingCode {
  if (orgId) {
    const membership = getMember(orgId, peppaUserId);
    if (!membership || membership.status !== 'active') {
      throw new Error('User is not an active member of this organization');
    }
  } else {
    const orgs = listUserOrgs(peppaUserId);
    orgId = orgs[0]?.id || '';
  }
  if (!orgId || !getOrgById(orgId)) {
    throw new Error('No organization available for binding');
  }
  const store = readStore();
  pruneExpiredCodes(store);
  let code = makeCode();
  while (store.codes.some(item => item.code === code)) code = makeCode();
  const bindingCode: BindingCode = {
    code,
    platform,
    peppaUserId,
    orgId,
    createdAt: now(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
  store.codes.push(bindingCode);
  writeStore(store);
  return bindingCode;
}

export function consumeBindingCode(platform: MessagingPlatformId, code: string, platformUserId: string): MessagingBinding | null {
  const store = readStore();
  pruneExpiredCodes(store);
  const normalized = code.trim().toUpperCase();
  const idx = store.codes.findIndex(item => item.platform === platform && item.code === normalized);
  if (idx < 0) {
    writeStore(store);
    return null;
  }
  const found = store.codes.splice(idx, 1)[0];
  const ts = now();
  const existingIdx = store.bindings.findIndex(item => item.platform === platform && item.platformUserId === platformUserId);
  const binding: MessagingBinding = {
    id: existingIdx >= 0 ? store.bindings[existingIdx].id : randomUUID(),
    platform,
    platformUserId,
    peppaUserId: found.peppaUserId,
    orgId: found.orgId,
    createdAt: existingIdx >= 0 ? store.bindings[existingIdx].createdAt : ts,
    updatedAt: ts,
  };
  if (existingIdx >= 0) store.bindings[existingIdx] = binding;
  else store.bindings.push(binding);
  writeStore(store);
  return binding;
}

export function getBinding(platform: MessagingPlatformId, platformUserId: string): MessagingBinding | null {
  const store = readStore();
  return store.bindings.find(item => item.platform === platform && item.platformUserId === platformUserId) || null;
}

export function listBindingsForUser(peppaUserId: string): MessagingBinding[] {
  return readStore().bindings.filter(item => item.peppaUserId === peppaUserId);
}

export function deleteBindingForUser(peppaUserId: string, bindingId: string): boolean {
  const store = readStore();
  const idx = store.bindings.findIndex(item => item.id === bindingId && item.peppaUserId === peppaUserId);
  if (idx < 0) return false;
  store.bindings.splice(idx, 1);
  writeStore(store);
  return true;
}
