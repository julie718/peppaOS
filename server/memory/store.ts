import { readDB, writeDB } from '../../db_layer';
import { logger } from '../lib/logger';
import { Memory, MemoryQuery, MemoryType, MemoryTier, MemoryPerspective } from './types';
import { applyMemoryFirewallMetadata, evaluateMemoryFirewall } from './firewall';
import { guardIllegalAddMemory } from '../../src/utils/paradigmGuard';

function getMemoryStore(): Memory[] {
  const db = readDB();
  if (!db.memories) db.memories = [];
  return db.memories;
}

// ── Phase2 模块4：长期记忆权重衰减参数（.env 可配置）──
function envNum(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
/** 每轮维护的基础衰减量（0-0.2，默认 0.01；实际衰减 = 基础量 × tier倍率 × retention倍率 × 权重系数） */
export const MEMORY_DECAY_RATE = envNum('MEMORY_DECAY_RATE', 0.01, 0, 0.2);
/** 摘要模糊化阈值：score ≤ 该值时生成 blurSummary（核心梗概保留，细节模糊） */
export const MEMORY_BLUR_THRESHOLD = envNum('MEMORY_BLUR_THRESHOLD', 0.35, 0, 1);
/** 休眠阈值：score ≤ 该值时标记休眠（hibernated=1，日常检索排除；记录永不删除 — 铁则1） */
export const MEMORY_HIBERNATE_THRESHOLD = envNum('MEMORY_HIBERNATE_THRESHOLD', 0.2, 0, 1);
/** 检索强化回补：记忆被召回时 score 提升量（召回 = 强化，对抗时间衰减） */
export const MEMORY_RETRIEVAL_BOOST = envNum('MEMORY_RETRIEVAL_BOOST', 0.05, 0, 0.5);

/** 归一化记忆权重：旧数据无 score 字段 → 视为满权重 1.0 */
export function getMemoryScore(m: Memory): number {
  return typeof m.score === 'number' && Number.isFinite(m.score)
    ? Math.min(1, Math.max(0, m.score))
    : 1;
}

/** 权重衰减的 tier 倍率：core_identity 永不衰减（高权重保护），growth 衰减减半 */
const TIER_DECAY_MULT: Record<MemoryTier, number> = {
  core_identity: 0,
  growth: 0.5,
  internalized: 0.75,
  episodic: 1,
};

/** 权重衰减的 retention 倍率：短期会话记忆快速衰减，长期/永久保留记忆缓慢衰减 */
const RETENTION_DECAY_MULT: Record<string, number> = {
  ephemeral: 3,
  session: 2,
  long_term: 1,
  permanent: 0.5,
};

/** 摘要模糊化：生成核心梗概（类型 + 首分句截断 + 关键词），细节模糊；原始 content 永不删除 */
function buildBlurSummary(m: Memory): string {
  const typeLabel = m.type === 'knowledge' ? '知识' : m.type === 'preference' ? '偏好' : m.type === 'habit' ? '习惯' : '事实';
  // 首分句（逗号/句号处截断）+ 30 字上限：细节抹去，核心梗概保留
  const firstClause = (m.content || '').replace(/\s+/g, ' ').split(/[，。！？；,!?;]/u, 1)[0]?.trim() || '';
  const head = firstClause.length > 30 ? firstClause.slice(0, 30) + '…' : firstClause;
  const kw = (m.keywords || []).slice(0, 3).join('、');
  const gist = [typeLabel, head].filter(Boolean).join('：');
  return kw ? `${gist}（关键词：${kw}）` : gist;
}

// ── Embedding / Vector Search ──

/** LRU cache for embeddings: text → vector. Avoids re-embedding the same content. */
const embeddingCache = new Map<string, number[]>();
const EMBEDDING_CACHE_MAX = 500;

function cacheEmbedding(text: string, vec: number[]) {
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const first = embeddingCache.keys().next().value;
    if (first) embeddingCache.delete(first);
  }
  embeddingCache.set(text, vec);
}

function getCachedEmbedding(text: string): number[] | undefined {
  return embeddingCache.get(text);
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Generate embedding vector via OpenAI text-embedding-3-small. Returns null if API unavailable. */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  // Check cache first
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const json = await res.json() as any;
    const vec = json.data?.[0]?.embedding;
    if (vec && Array.isArray(vec) && vec.length > 0) {
      cacheEmbedding(text, vec);
      return vec;
    }
    return null;
  } catch {
    return null; // API unavailable — silent fallback to keyword search
  }
}

/** Async background embedding generation — updates memory in-place */
async function attachEmbedding(memory: Memory): Promise<void> {
  if (memory.embedding && memory.embedding.length > 0) return;
  const text = `${memory.type}: ${memory.content} ${(memory.keywords ?? []).join(' ')}`;
  const vec = await generateEmbedding(text);
  if (vec) {
    memory.embedding = vec;
    try {
      const all = getMemoryStore();
      const existing = all.find(m => m.id === memory.id);
      if (existing) {
        existing.embedding = vec;
        saveMemoryStore(all);
      }
    } catch {}
  }
}

// ── Hebbian Co-Retrieval Map — "cells that fire together, wire together" ──
// When memories are retrieved in the same query, their pairwise association strengthens.
// Over time, this builds an organic associative network that mirrors the user's mental model.

type CoRetrievalMap = Map<string, Map<string, Map<string, number>>>;
// userId → memoryId → (associatedMemoryId → strength 0-1)

let coRetrievalMap: CoRetrievalMap = new Map();
const ASSOCIATION_STRENGTH_INCREMENT = 0.08;  // Per co-retrieval boost
const ASSOCIATION_DECAY_RATE = 0.02;           // Per decay cycle
const ASSOCIATION_THRESHOLD = 0.25;            // Min strength to be considered "associated"

function getAssocKey(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA]; // Canonical ordering
}

/** Load co-retrieval map from DB on startup */
function loadCoRetrievalMap(): void {
  try {
    const db = readDB();
    if (db.memoryAssociations && Array.isArray(db.memoryAssociations)) {
      for (const row of db.memoryAssociations) {
        if (!coRetrievalMap.has(row.userId)) {
          coRetrievalMap.set(row.userId, new Map());
        }
        const userMap = coRetrievalMap.get(row.userId)!;
        if (!userMap.has(row.memA)) userMap.set(row.memA, new Map());
        userMap.get(row.memA)!.set(row.memB, row.strength);
        // Symmetric
        if (!userMap.has(row.memB)) userMap.set(row.memB, new Map());
        userMap.get(row.memB)!.set(row.memA, row.strength);
      }
    }
  } catch {}
}

/** Persist co-retrieval map to DB */
function saveCoRetrievalMap(): void {
  try {
    const db = readDB();
    const rows: { userId: string; memA: string; memB: string; strength: number }[] = [];
    for (const [userId, userMap] of coRetrievalMap) {
      for (const [memA, assocMap] of userMap) {
        for (const [memB, strength] of assocMap) {
          if (memA < memB && strength >= ASSOCIATION_THRESHOLD) {
            rows.push({ userId, memA, memB, strength: +strength.toFixed(3) });
          }
        }
      }
    }
    db.memoryAssociations = rows;
    writeDB(db);
  } catch {}
}

/** Hebbian strengthen: increment association strength between all pairs in a co-retrieved set */
function strengthenAssociations(userId: string, memoryIds: string[]): void {
  if (memoryIds.length < 2) return;

  if (!coRetrievalMap.has(userId)) coRetrievalMap.set(userId, new Map());
  const userMap = coRetrievalMap.get(userId)!;

  for (let i = 0; i < memoryIds.length; i++) {
    for (let j = i + 1; j < memoryIds.length; j++) {
      const idA = memoryIds[i], idB = memoryIds[j];

      if (!userMap.has(idA)) userMap.set(idA, new Map());
      const aMap = userMap.get(idA)!;
      const prev = aMap.get(idB) || 0;
      aMap.set(idB, Math.min(1, +(prev + ASSOCIATION_STRENGTH_INCREMENT).toFixed(3)));

      if (!userMap.has(idB)) userMap.set(idB, new Map());
      userMap.get(idB)!.set(idA, Math.min(1, +(prev + ASSOCIATION_STRENGTH_INCREMENT).toFixed(3)));
    }
  }

  // Persist periodically (on every ~10th co-retrieval, to avoid excessive writes)
  saveCoRetrievalMap();

  // [Phase3 加法桥] 联想边监听器：通知 P3 记忆联想网络模块（memory_association）持久化到
  // life.db memory_associations 表。无监听器注册时零开销、零行为变化（纯新增，不改既有逻辑）。
  notifyAssociationListeners(userId, memoryIds);
}

// ── Phase3 加法桥：P3 记忆联想网络模块（server/memory_association/）的持久化对接 ──
// 背景：coRetrievalMap 原为纯内存 + writeDB 落 JSON（db_layer 持久化清单不含 memoryAssociations，
// 重启归零）。P3 模块以 life.db memory_associations 表为持久真相，本桥只做三件事：
//   1) strengthen 后通知监听器（P3 模块把最新联想写入自身表）；
//   2) getCoRetrievalSnapshot 只读导出（P3 模块初始化时导入历史数据）；
//   3) hydrateCoRetrievalMap 水合导入（P3 模块重启后把持久化边恢复进内存，修复重启归零缺陷）。
// 全部为纯新增导出；未注册监听器时行为与既有实现完全一致。

type AssociationListener = (userId: string, memoryIds: string[]) => void;
const associationListeners: AssociationListener[] = [];

/** 注册联想边监听器（P3 memory_association 模块调用；注册后每次强化即收到通知） */
export function registerAssociationListener(listener: AssociationListener): void {
  if (!associationListeners.includes(listener)) associationListeners.push(listener);
}

function notifyAssociationListeners(userId: string, memoryIds: string[]): void {
  for (const listener of associationListeners) {
    try { listener(userId, memoryIds); } catch { /* 监听器异常不阻断主链路 */ }
  }
}

/** 只读快照：导出当前用户（或全部）的共检索联想边（规范序去重，strength >= 0.01） */
export function getCoRetrievalSnapshot(userId?: string): { userId: string; memA: string; memB: string; strength: number }[] {
  const rows: { userId: string; memA: string; memB: string; strength: number }[] = [];
  const targets = userId ? [userId] : [...coRetrievalMap.keys()];
  for (const uid of targets) {
    const userMap = coRetrievalMap.get(uid);
    if (!userMap) continue;
    for (const [memA, assocMap] of userMap) {
      for (const [memB, strength] of assocMap) {
        if (memA < memB && strength >= 0.01) rows.push({ userId: uid, memA, memB, strength: +strength.toFixed(3) });
      }
    }
  }
  return rows;
}

/** 水合导入：把持久化的联想边恢复进内存共检索图（不触发落盘，避免与 P3 表重复写入） */
export function hydrateCoRetrievalMap(userId: string, rows: { memA: string; memB: string; strength: number }[]): void {
  if (!rows || rows.length === 0) return;
  if (!coRetrievalMap.has(userId)) coRetrievalMap.set(userId, new Map());
  const userMap = coRetrievalMap.get(userId)!;
  for (const r of rows) {
    const s = Math.min(1, Math.max(0, r.strength));
    if (!userMap.has(r.memA)) userMap.set(r.memA, new Map());
    userMap.get(r.memA)!.set(r.memB, s);
    if (!userMap.has(r.memB)) userMap.set(r.memB, new Map());
    userMap.get(r.memB)!.set(r.memA, s);
  }
}

/** Periodically decay weak associations and remove dead ones */
export function decayMemoryAssociations(userId: string): number {
  const sizeBefore = coRetrievalMap.get(userId)?.size || 0;
  decayAssociations(userId);
  const sizeAfter = coRetrievalMap.get(userId)?.size || 0;
  if (sizeBefore !== sizeAfter) saveCoRetrievalMap();
  return sizeBefore - sizeAfter;
}

/** Initialize co-retrieval map from persistent storage */
export function initMemoryAssociations(): void {
  loadCoRetrievalMap();
}

/** Decay all associations — weak ones fade, strong ones persist */
function decayAssociations(userId: string): void {
  const userMap = coRetrievalMap.get(userId);
  if (!userMap) return;

  for (const [memId, assocMap] of userMap) {
    for (const [otherId, strength] of assocMap) {
      const newStrength = +(strength - ASSOCIATION_DECAY_RATE).toFixed(3);
      if (newStrength <= 0) {
        assocMap.delete(otherId);
      } else {
        assocMap.set(otherId, newStrength);
      }
    }
    if (assocMap.size === 0) userMap.delete(memId);
  }
  if (userMap.size === 0) coRetrievalMap.delete(userId);
}

/** Get memories strongly associated with a given memory ID */
export function getAssociatedMemories(memoryId: string, userId: string, threshold: number = ASSOCIATION_THRESHOLD): Memory[] {
  const userMap = coRetrievalMap.get(userId);
  if (!userMap) return [];
  const assocMap = userMap.get(memoryId);
  if (!assocMap) return [];

  const all = getMemoryStore();
  const result: Memory[] = [];
  for (const [assocId, strength] of assocMap) {
    if (strength >= threshold) {
      const mem = all.find(m => m.id === assocId);
      if (mem) result.push(mem);
    }
  }
  return result;
}

// ── Dedup index (lazy, invalidated on write) ──

let dedupIndex: Map<string, Map<string, Memory[]>> | null = null;

function getDedupIndex(): Map<string, Map<string, Memory[]>> {
  if (dedupIndex) return dedupIndex;
  dedupIndex = new Map();
  for (const m of getMemoryStore()) {
    if (!dedupIndex.has(m.userId)) dedupIndex.set(m.userId, new Map());
    const typeMap = dedupIndex.get(m.userId)!;
    if (!typeMap.has(m.type)) typeMap.set(m.type, []);
    typeMap.get(m.type)!.push(m);
  }
  return dedupIndex;
}

function saveMemoryStore(memories: Memory[]): void {
  dedupIndex = null; // invalidate index on write
  const db = readDB();
  db.memories = memories;
  writeDB(db);
}

function generateId(): string {
  return `mem_${crypto.randomUUID()}`;
}

// Match CJK characters for language-aware tokenization
const CJK_RE = /[一-鿿㐀-䶿]/;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // Extract CJK character bigrams (overlapping pairs: 名字 → 名字)
  let cjkRun = '';
  for (const ch of lower) {
    if (CJK_RE.test(ch)) {
      cjkRun += ch;
      if (cjkRun.length >= 2) {
        tokens.push(cjkRun.slice(-2));
      }
    } else {
      if (cjkRun.length === 1) tokens.push(cjkRun); // lone CJK char
      cjkRun = '';
    }
  }
  if (cjkRun.length === 1) tokens.push(cjkRun);
  // Also split by whitespace for English/numbers
  const words = lower.split(/[\s,，。！？、；：""''（）\(\)\[\]【】]+/).filter(w => w.length > 1);
  for (const w of words) {
    if (!CJK_RE.test(w)) tokens.push(w);
    else if (w.length > 2) tokens.push(w); // keep full CJK words too
  }
  return [...new Set(tokens)];
}

/** Score query against memory using language-aware token overlap, with recency bonus */
function relevanceScore(query: string, memory: Memory): number {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return memory.confidence ?? 0.5; // E-1: undefined 归一化

  const contentLower = memory.content.toLowerCase();
  let hits = 0;
  for (const t of qTokens) {
    if (contentLower.includes(t)) { hits += 2; continue; }
    let kwHit = false;
    for (const kw of (memory.keywords ?? [])) {
      if (kw.toLowerCase().includes(t) || t.includes(kw.toLowerCase())) { kwHit = true; break; }
    }
    if (kwHit) hits += 1;
  }
  let score = (hits / (qTokens.length * 2)) * (memory.confidence ?? 0.5); // E-1

  // Temporal recency boost: recent memories get higher scores for cross-session continuity
  const hoursAgo = (Date.now() - new Date(memory.updatedAt).getTime()) / (1000 * 60 * 60);
  if (hoursAgo < 1) score *= 1.3;        // Last hour: strong boost
  else if (hoursAgo < 24) score *= 1.15;  // Today: moderate boost
  else if (hoursAgo < 72) score *= 1.05;  // Last 3 days: slight boost

  return score;
}

export function queryMemories(q: MemoryQuery): Memory[] {
  const all = getMemoryStore();

  const cutoffB = q.before ? new Date(q.before).getTime() : 0;
  const cutoffA = q.after ? new Date(q.after).getTime() : 0;

  // Single-pass filter combining all conditions
  let memories = all.filter(m => {
    // Phase2 模块4：休眠记忆默认排除（includeHibernated=true 时仍可查询，铁则1：记录永不删除）
    if (m.hibernated === true && !q.includeHibernated) return false;
    if (q.userId && m.userId !== q.userId) return false;
    if (q.agentId !== undefined && (m.agentId || '') !== q.agentId) return false;
    if (q.type && m.type !== q.type) return false;
    if (q.minConfidence !== undefined && m.confidence < q.minConfidence) return false;
    if (q.tier && m.tier !== q.tier) return false;
    if (q.perspective && m.perspective !== q.perspective) return false;
    if (q.minImportance !== undefined && m.importance < q.minImportance) return false;
    if (q.unconsolidatedOnly && m.parentId) return false;
    if (q.parentId !== undefined && m.parentId !== q.parentId) return false;
    if (q.nodeType && m.nodeType !== q.nodeType) return false;
    if (q.before && new Date(m.createdAt).getTime() > cutoffB) return false;
    if (q.after && new Date(m.createdAt).getTime() < cutoffA) return false;
    if (q.location !== undefined && (m.location || '') !== q.location) return false;
    if (q.domain !== undefined && (m.domain || 'personal') !== q.domain) return false;
    if (q.orgId !== undefined && (m.orgId || '') !== q.orgId) return false;
    return true;
  });

  // Tier-based priority: core_identity always first, then growth, then internalized, then episodic
  const tierPriority: Record<string, number> = {
    core_identity: 0,
    growth: 1,
    internalized: 2,
    episodic: 3,
  };

  // Retrieve personality-driven retrieval biases (cross-system fusion: vector→memory)
  const typeBias = q.retrievalTypeWeights || {};
  const perspectiveBias = q.retrievalPerspectiveWeights || {};
  const hasBias = Object.keys(typeBias).length > 0 || Object.keys(perspectiveBias).length > 0;

  if (q.query) {
    const scored = memories
      .map(m => {
        let score = relevanceScore(q.query!, m);
        // Apply personality-driven retrieval biases
        if (hasBias && score > 0) {
          const typeMult = typeBias[m.type] || 1;
          const perspMult = perspectiveBias[m.perspective] || 1;
          score = +(score * typeMult * perspMult).toFixed(4);
        }
        return { m, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => {
        // Tier priority overrides score within same magnitude
        const tierDiff = (tierPriority[a.m.tier] || 3) - (tierPriority[b.m.tier] || 3);
        if (Math.abs(tierDiff) >= 2) return tierDiff;
        return b.score - a.score;
      });
    memories = scored.map(({ m }) => m);
  } else {
    // Sort by tier priority, then importance, then confidence, then recency
    // Apply personality-driven perspective bias to priority sorting
    memories.sort((a, b) => {
      const tierDiff = (tierPriority[a.tier] || 3) - (tierPriority[b.tier] || 3);
      if (tierDiff !== 0) return tierDiff;
      if (b.importance !== a.importance) return b.importance - a.importance;
      // self-perspective memories take priority over owner traits (boosted by personality bias)
      const perspWeightA = perspectiveBias[a.perspective] || 1;
      const perspWeightB = perspectiveBias[b.perspective] || 1;
      const perspA = (a.perspective === 'peppa_self' || a.perspective === 'peppa_growth' ? 0 : 1) / perspWeightA;
      const perspB = (b.perspective === 'peppa_self' || b.perspective === 'peppa_growth' ? 0 : 1) / perspWeightB;
      if (perspA !== perspB) return perspA - perspB;
      // Type bias affects tie-breaking
      const typeWeightA = typeBias[a.type] || 1;
      const typeWeightB = typeBias[b.type] || 1;
      if (typeWeightA !== typeWeightB) return typeWeightB - typeWeightA;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  const limit = q.limit || 10;
  const result = memories.slice(0, limit);

  // ── Hebbian learning: co-retrieved memories strengthen pairwise associations ──
  if (q.userId && result.length >= 2) {
    const resultIds = result.map(m => m.id);
    strengthenAssociations(q.userId, resultIds);

    // Enrich: pull in strongly associated memories not already in the result
    const resultIdSet = new Set(resultIds);
    const associated: Memory[] = [];
    for (const m of result) {
      const assoc = getAssociatedMemories(m.id, q.userId);
      for (const am of assoc) {
        if (!resultIdSet.has(am.id)) {
          resultIdSet.add(am.id);
          associated.push(am);
        }
      }
    }
    if (associated.length > 0) {
      // Append associated memories after direct matches
      associated.sort((a, b) => (b.importance || 0) - (a.importance || 0));
      result.push(...associated.slice(0, Math.ceil(limit * 0.5)));
    }
  } else if (q.userId && result.length === 1) {
    // Single result: still record it for future co-retrieval opportunities
    // (no pairwise to strengthen, but we can use this info later)
  }

  // Mark as retrieved (including associated ones)
  // P0-5: noTouch 查询（GC 巡检）不刷新检索时间，避免污染低频判定
  const now = new Date().toISOString();
  const store = getMemoryStore();
  for (const m of result) {
    const stored = store.find(s => s.id === m.id);
    if (stored) {
      if (q.noTouch) continue;
      stored.lastRetrievedAt = now;
      stored.retrieveCount = (stored.retrieveCount || 0) + 1;
      // Phase2 模块4：检索强化回补 — 被召回 = 被需要，权重回补对抗时间衰减
      const currentScore = getMemoryScore(stored);
      if (currentScore < 1) {
        stored.score = Math.min(1, +(currentScore + MEMORY_RETRIEVAL_BOOST).toFixed(4));
      }
    }
  }
  if (result.length > 0) saveMemoryStore(store);

  return result;
}

/** Async vector-based semantic search. Falls back to keyword search if embeddings unavailable. */
export async function queryMemoriesVector(q: MemoryQuery): Promise<Memory[]> {
  if (!q.query || !q.useVector) {
    return queryMemories(q);
  }

  // Generate query embedding
  const queryVec = await generateEmbedding(q.query);
  if (!queryVec) {
    // Embeddings unavailable — fall back to keyword search
    return queryMemories({ ...q, useVector: false });
  }

  // Score all keyword-filtered results with cosine similarity
  const keywordResults = queryMemories({ ...q, useVector: false });
  const scored = keywordResults
    .map(m => {
      if (!m.embedding || m.embedding.length === 0) {
        return { m, score: relevanceScore(q.query!, m) }; // fallback for unembedded memories
      }
      const cos = cosineSimilarity(queryVec, m.embedding);
      return { m, score: +(cos * (m.confidence ?? 0.5)).toFixed(4) }; // E-1
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const limit = q.limit || 5;
  return scored.slice(0, limit).map(({ m }) => m);
}

/** Pre-generate embeddings for all existing memories that lack them. One-time migration. */
export async function backfillEmbeddings(userId?: string): Promise<number> {
  const all = getMemoryStore();
  const targets = all.filter(m => !m.embedding && (!userId || m.userId === userId));
  let count = 0;
  for (const m of targets) {
    const vec = await generateEmbedding(`${m.type}: ${m.content} ${(m.keywords ?? []).join(' ')}`);
    if (vec) {
      m.embedding = vec;
      count++;
    }
    // Small delay to avoid rate limits
    if (count % 10 === 0 && count > 0) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (count > 0) saveMemoryStore(all);
  return count;
}

// ── Reminders ──

export interface Reminder {
  id: string;
  userId: string;
  content: string;
  dueAt: string | null;
  status: 'pending' | 'fired';
  sourceInteractionId: string;
  createdAt: string;
  firedAt: string | null;
}

function getReminderStore(): Reminder[] {
  const db = readDB();
  if (!db.reminders) db.reminders = [];
  return db.reminders;
}

function saveReminderStore(reminders: Reminder[]): void {
  const db = readDB();
  db.reminders = reminders;
  writeDB(db);
}

export function addReminder(reminder: Omit<Reminder, 'id' | 'createdAt' | 'status' | 'firedAt'>): Reminder {
  const all = getReminderStore();
  const now = new Date().toISOString();
  const newReminder: Reminder = {
    id: `rem_${crypto.randomUUID()}`,
    ...reminder,
    status: 'pending',
    createdAt: now,
    firedAt: null,
  };
  all.push(newReminder);
  saveReminderStore(all);
  return newReminder;
}

export function getDueReminders(): Reminder[] {
  const all = getReminderStore();
  const now = new Date().toISOString();
  return all
    .filter(r => r.status === 'pending' && r.dueAt && r.dueAt <= now)
    .slice(0, 10);
}

export function fireReminder(id: string): void {
  const all = getReminderStore();
  const r = all.find(r => r.id === id);
  if (r) {
    r.status = 'fired';
    r.firedAt = new Date().toISOString();
    saveReminderStore(all);
  }
}

// ── Memories ──

export function addMemory(
  memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'lastRetrievedAt' | 'retrieveCount' | 'tier' | 'perspective' | 'importance' | 'parentId' | 'agentId' | 'nodeType'>,
  overrides?: {
    tier?: Memory['tier'];
    perspective?: Memory['perspective'];
    importance?: number;
    parentId?: string | null;
    agentId?: string;
    nodeType?: Memory['nodeType'];
    location?: string;
    domain?: string;
    orgId?: string;
    source?: Memory['source'];
    privacyClass?: Memory['privacyClass'];
    retention?: Memory['retention'];
    userApproved?: boolean;
  },
): Memory {
  // PHASE0-DISABLED 配套守卫：addMemory 白名单检测（①chat轮次结束回调 ②MCP工具回调 ③InnerTick预留；其余调用点告警不阻断）
  guardIllegalAddMemory();
  const all = getMemoryStore();
  // E-1: 置信度默认值统一 0.5 — 修复前调用方未传 confidence 时，undefined 参与
  // 排序/相似度评分/矛盾判定，检索质量不可预期；现入口处归一化，全链路可见一致默认值
  const confidence = memory.confidence ?? 0.5;
  const tier = overrides?.tier ?? 'episodic';
  const domain = overrides?.domain ?? memory.domain ?? 'personal';
  const orgId = overrides?.orgId ?? memory.orgId ?? '';
  const firewall = evaluateMemoryFirewall({
    userId: memory.userId,
    content: memory.content,
    tier,
    source: overrides?.source ?? memory.source,
    domain,
    orgId,
    privacyClass: overrides?.privacyClass ?? memory.privacyClass,
    retention: overrides?.retention ?? memory.retention,
    userApproved: overrides?.userApproved ?? memory.userApproved,
  });
  if (!firewall.accepted) {
    throw new Error(`Memory blocked by firewall: ${firewall.reason}`);
  }

  // Check for contradictions with existing memories of same user+type
  const candidates = all.filter(m => m.userId === memory.userId && m.type === memory.type);
  const contradictions = findContradictions(memory.content, memory.userId, memory.type, candidates);
  for (const conflicted of contradictions) {
    // Reduce confidence of the older memory — it may be outdated
    conflicted.confidence = Math.max(0.1, +(conflicted.confidence - 0.15).toFixed(2));
    conflicted.updatedAt = new Date().toISOString();
    logger.info(
      `[Memory] Contradiction detected: new="${memory.content.slice(0, 50)}..." ` +
      `vs existing="${conflicted.content.slice(0, 50)}..." (confidence: ${(conflicted.confidence + 0.15).toFixed(2)}→${conflicted.confidence.toFixed(2)})`,
    );
  }

  // Deduplicate using index — only scan same userId + type
  const idx = getDedupIndex();
  const dedupCandidates = idx.get(memory.userId)?.get(memory.type) || [];
  const existing = dedupCandidates.find(m =>
    contentSimilarity(m.content, memory.content) > 0.7,
  );

  const now = new Date().toISOString();

  if (existing) {
    // Merge: increase confidence, update content if new one has higher confidence
    existing.content = confidence > existing.confidence ? memory.content : existing.content;
    existing.keywords = dedupeKeywords([...(existing.keywords ?? []), ...(memory.keywords ?? [])]);
    existing.confidence = Math.min(1, existing.confidence + 0.1);
    // P0-5: 合并重要度改为加权取小（平均值），支持重要度衰减下降，而非只升不降
    existing.importance = Math.max(0.1, +((existing.importance + (overrides?.importance ?? 0.3)) / 2).toFixed(4));
    existing.updatedAt = now;
    existing.domain = domain;
    existing.orgId = orgId;
    // applyMemoryFirewallMetadata 返回新对象（纯函数）→ 需原位合并，否则 source/retention 等元数据丢失
    Object.assign(existing, applyMemoryFirewallMetadata(existing, firewall));
    saveMemoryStore(all);
    return existing;
  }

  const newMemory: Memory = {
    id: generateId(),
    ...memory,
    confidence, // E-1: 归一化默认值，杜绝 undefined 落库
    createdAt: now,
    updatedAt: now,
    lastRetrievedAt: null,
    retrieveCount: 0,
    tier,
    perspective: overrides?.perspective ?? 'owner_trait',
    importance: overrides?.importance ?? 0.3,
    parentId: overrides?.parentId ?? null,
    agentId: overrides?.agentId ?? '',
    nodeType: overrides?.nodeType ?? 'leaf',
    location: overrides?.location,
    domain,
    orgId,
    // Phase2 模块4：权重衰减字段默认值（满权重 1.0、未休眠、无模糊梗概）
    score: 1.0,
    hibernated: false,
    hibernatedAt: null,
    blurSummary: null,
  };
  // applyMemoryFirewallMetadata 返回新对象（纯函数）→ 需原位合并，否则 source/retention 等元数据丢失
  Object.assign(newMemory, applyMemoryFirewallMetadata(newMemory, firewall));

  all.push(newMemory);
  saveMemoryStore(all);

  // Background: generate embedding for semantic search
  attachEmbedding(newMemory).catch(() => {});

  return newMemory;
}

export function removeMemory(id: string): boolean {
  const all = getMemoryStore();
  const idx = all.findIndex(m => m.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  saveMemoryStore(all);
  return true;
}

/**
 * P0-5: 直接调整单条记忆重要度（原地修改，不触发合并/置信度副作用）。
 * 供 MemoryGC 低频降权与合并固化使用，支持重要度双向变化。
 */
export function setMemoryImportance(id: string, importance: number): boolean {
  const all = getMemoryStore();
  const mem = all.find(m => m.id === id);
  if (!mem) return false;
  mem.importance = Math.max(0.1, Math.min(1, +(importance).toFixed(4)));
  mem.updatedAt = new Date().toISOString();
  saveMemoryStore(all);
  return true;
}

/**
 * Bug 修复：MemoryGC 冬眠分支支持 —— 标记单条记忆休眠（hibernated=1 + hibernatedAt）。
 * 记录永不删除（铁则1），仅日常检索排除（includeHibernated=true 仍可查）；
 * 落库方式与 dynamicDecayMemories 的休眠标记保持一致。
 */
export function hibernateMemory(id: string, userId: string): boolean {
  const all = getMemoryStore();
  const mem = all.find(m => m.id === id);
  if (!mem || mem.userId !== userId) return false;
  if (mem.hibernated === true) return false; // 已休眠：幂等
  mem.hibernated = true;
  mem.hibernatedAt = new Date().toISOString();
  mem.updatedAt = new Date().toISOString();
  saveMemoryStore(all);
  return true;
}

/** Tier-based decay: core_identity never decays, episodic decays fast */
export function decayMemories(userId: string): void {
  const all = getMemoryStore();
  let changed = false;

  const decayRates: Record<MemoryTier, { amount: number; min: number }> = {
    core_identity: { amount: 0, min: 0.9 },     // Never decays
    growth: { amount: 0.02, min: 0.6 },          // Very slow
    internalized: { amount: 0.03, min: 0.3 },    // Slow
    episodic: { amount: 0.05, min: 0.1 },        // Fast
  };

  for (const m of all) {
    if (m.userId !== userId) continue;
    const rate = decayRates[m.tier] || decayRates.episodic;
    if (rate.amount === 0) continue;
    if (m.confidence <= rate.min) continue;
    m.confidence = Math.max(rate.min, +(m.confidence - rate.amount).toFixed(2));
    changed = true;
  }

  if (changed) saveMemoryStore(all);
}

/** Get episodic memories that are ready for consolidation (unconsolidated, count >= threshold) */
export function getUnconsolidatedEpisodic(userId: string, domain?: string, orgId?: string): Memory[] {
  return getMemoryStore().filter(m =>
    m.userId === userId &&
    m.tier === 'episodic' &&
    !m.parentId &&
    m.confidence >= 0.2 &&
    (domain ? (m.domain || 'personal') === domain : true) &&
    (orgId !== undefined ? (m.orgId || '') === orgId : true)
  );
}

/** Mark episodic memories as consolidated by setting parentId */
export function markConsolidated(ids: string[], parentId: string): void {
  const all = getMemoryStore();
  for (const m of all) {
    if (ids.includes(m.id)) {
      m.parentId = parentId;
      // Promote consolidated memories — they're now part of something bigger
      m.importance = Math.min(1, m.importance + 0.2);
    }
  }
  saveMemoryStore(all);
}

export function formatMemoriesForContext(memories: Memory[]): string {
  if (memories.length === 0) return '';

  // Separate branches and leaves
  const branches = memories.filter(m => m.nodeType === 'branch');
  const leaves = memories.filter(m => m.nodeType !== 'branch');

  const lines: string[] = [];

  // Group leaves by parent
  const byParent = new Map<string | null, Memory[]>();
  for (const leaf of leaves) {
    const key = leaf.parentId || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(leaf);
  }

  // Sort branches by importance
  branches.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);

  // Output branch sections
  for (const branch of branches) {
    const children = byParent.get(branch.id) || [];
    if (children.length === 0) continue;
    lines.push(`### ${branch.content}`);
    children.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
    for (const m of children) {
      lines.push(`- ${m.content}`);
    }
  }

  // Output ungrouped leaves (no parent branch)
  const orphans = byParent.get(null) || [];
  if (orphans.length > 0) {
    for (const m of orphans) {
      // Filter out branches from the root display
      if (m.nodeType !== 'branch') {
        lines.push(`- ${m.content}`);
      }
    }
  }

  return lines.join('\n');
}

// ── OpenHer-inspired Memory Crystallization ──

/**
 * Compute a dynamic memory value score (0-1) based on:
 * - Retrieve frequency (how often is this memory recalled)
 * - Recency (how recently was it used)
 * - Confidence (how sure are we)
 * - Connectedness (is it part of a branch tree)
 * - Hebbian association strength (cross-system fusion: Hebbian→crystallization)
 *
 * High-value episodic memories are candidates for auto-promotion.
 */
export function computeMemoryValue(memory: Memory, childrenCount: number = 0, hebbianBonus: number = 0): number {
  const now = Date.now();

  // Recency bonus: memories retrieved within the last 24h get a bonus
  const hoursSinceRetrieve = memory.lastRetrievedAt
    ? (now - new Date(memory.lastRetrievedAt).getTime()) / (1000 * 60 * 60)
    : 72; // Never retrieved → treat as 3 days old
  const recencyScore = Math.max(0, 1 - hoursSinceRetrieve / 72); // Decay over 72h

  // Retrieve frequency: log-scale so the 1st retrieval matters most
  const retrieveScore = Math.min(1, Math.log2(memory.retrieveCount + 1) / 5); // log2(33) ≈ 5

  // Confidence
  const confidenceScore = memory.confidence;

  // Connectedness: having a parent or children adds value
  const connectedBonus = childrenCount > 0
    ? Math.min(0.2, childrenCount * 0.05) // Up to 0.2 bonus
    : memory.parentId ? 0.1 : 0;

  // Hebbian fusion: memories that "fire together" with many others are more valuable
  const hebbianScore = Math.min(0.15, hebbianBonus * 0.15); // Up to 0.15 bonus

  // Weighted composite — Hebbian bonus partially replaces connectedness
  const value = (
    recencyScore * 0.20 +
    retrieveScore * 0.25 +
    confidenceScore * 0.30 +
    connectedBonus * 0.10 +
    hebbianScore * 0.15
  );

  return Math.min(1, +(value).toFixed(3));
}

/** Compute the average Hebbian association strength for a memory */
function getHebbianBonus(userId: string, memoryId: string): number {
  const userMap = coRetrievalMap.get(userId);
  if (!userMap) return 0;
  const assocMap = userMap.get(memoryId);
  if (!assocMap || assocMap.size === 0) return 0;
  let total = 0;
  for (const strength of assocMap.values()) {
    total += strength;
  }
  return +(total / assocMap.size).toFixed(3);
}

/**
 * Auto-promote high-value memories to higher tiers.
 * - Episodic → Internalized: value >= 0.65 for 3+ retrievals
 * - Internalized → Growth: value >= 0.8 for 5+ retrievals
 *
 * Cross-system fusion: intimacy lowers promotion thresholds.
 * Higher intimacy = memories crystallize more easily (the bond makes them meaningful).
 * Returns count of promoted memories.
 */
export function promoteMemories(userId: string, intimacy: number = 0): number {
  const all = getMemoryStore();
  let promoted = 0;

  // Intimacy modulation: higher intimacy → lower thresholds (up to 25% reduction)
  const intimacyMod = 1 - Math.min(0.25, intimacy * 0.25);
  const episodicThreshold = +(0.65 * intimacyMod).toFixed(2);
  const growthThreshold = +(0.80 * intimacyMod).toFixed(2);

  for (const m of all) {
    if (m.userId !== userId) continue;

    // Count children for connectedness bonus
    const childrenCount = all.filter(c => c.parentId === m.id).length;
    const hebbianBonus = getHebbianBonus(userId, m.id);
    const value = computeMemoryValue(m, childrenCount, hebbianBonus);

    if (m.tier === 'episodic' && value >= episodicThreshold && m.retrieveCount >= 3) {
      m.tier = 'internalized';
      m.importance = Math.min(1, m.importance + 0.15);
      m.updatedAt = new Date().toISOString();
      logger.info(`[Memory] Promoted episodic→internalized: "${m.content.slice(0, 50)}..." (value: ${value.toFixed(2)}, intimacy: ${intimacy.toFixed(2)})`);
      promoted++;
    } else if (m.tier === 'internalized' && value >= growthThreshold && m.retrieveCount >= 5) {
      m.tier = 'growth';
      m.importance = Math.min(1, m.importance + 0.2);
      m.updatedAt = new Date().toISOString();
      logger.info(`[Memory] Promoted internalized→growth: "${m.content.slice(0, 50)}..." (value: ${value.toFixed(2)}, intimacy: ${intimacy.toFixed(2)})`);
      promoted++;
    }
  }

  if (promoted > 0) saveMemoryStore(all);
  return promoted;
}

/**
 * Dynamic tier-based decay — value modulates the decay speed.
 * High-value memories resist decay; low-value ones decay faster.
 *
 * Phase2 模块4 扩展（长期记忆权重衰减，铁则1：永不物理删除）：
 *   1) score 权重衰减：实际衰减 = MEMORY_DECAY_RATE × tier倍率 × retention倍率 × 权重系数；
 *      权重系数 = 0.2 + 0.8×(1−score)（高分保护：满权重记忆衰减仅 1/5 速，低分加速淡出）；
 *      core_identity 倍率 = 0（永不衰减）；已休眠记录不再衰减（记录保留）。
 *   2) 摘要模糊化：score ≤ MEMORY_BLUR_THRESHOLD → 生成 blurSummary（细节模糊，梗概保留）。
 *   3) 休眠：score ≤ MEMORY_HIBERNATE_THRESHOLD → 标记 hibernated=1 + hibernatedAt，
 *      日常检索排除（queryMemories includeHibernated=true 仍可查，后台接口可查）。
 */
export function dynamicDecayMemories(userId: string): void {
  const all = getMemoryStore();
  let changed = false;

  const baseRates: Record<MemoryTier, { amount: number; min: number }> = {
    core_identity: { amount: 0, min: 0.9 },
    growth: { amount: 0.02, min: 0.6 },
    internalized: { amount: 0.03, min: 0.3 },
    episodic: { amount: 0.05, min: 0.1 },
  };

  for (const m of all) {
    if (m.userId !== userId) continue;
    if (m.hibernated) continue; // 已休眠：停止衰减，记录永久保留（铁则1）
    const rate = baseRates[m.tier] || baseRates.episodic;
    if (rate.amount === 0 && m.tier === 'core_identity') {
      // core_identity 永不衰减（含 score，双保险：TIER_DECAY_MULT 也为 0）
      continue;
    }
    if (m.confidence > rate.min) {
      // Value modulates decay: high-value memories resist decay
      const childrenCount = all.filter(c => c.parentId === m.id).length;
      const hebbianBonus = getHebbianBonus(userId, m.id);
      const value = computeMemoryValue(m, childrenCount, hebbianBonus);
      const modulation = 1 - (value * 0.6); // value=1 → 0.4x decay, value=0 → 1x decay
      const effectiveDecay = +(rate.amount * modulation).toFixed(3);

      if (effectiveDecay > 0) {
        m.confidence = Math.max(rate.min, +(m.confidence - effectiveDecay).toFixed(2));
        changed = true;
      }
    }

    // ── Phase2 模块4：score 权重衰减（高分保护 + 模糊化 + 休眠）──
    const score = getMemoryScore(m);
    if (score <= 0) continue;
    const tierMult = TIER_DECAY_MULT[m.tier] ?? 1;
    const retentionMult = RETENTION_DECAY_MULT[m.retention || 'long_term'] ?? 1;
    // 权重系数：score=1.0 → 0.2×（高分保护），score=0 → 1×（低分加速淡出）
    const weightFactor = 0.2 + 0.8 * (1 - score);
    const effectiveScoreDecay = +(MEMORY_DECAY_RATE * tierMult * retentionMult * weightFactor).toFixed(4);
    if (effectiveScoreDecay <= 0) continue;
    const nextScore = Math.max(0, +(score - effectiveScoreDecay).toFixed(4));
    if (nextScore === score) continue;
    m.score = nextScore;
    m.updatedAt = new Date().toISOString();
    changed = true;

    // 摘要模糊化：达到模糊阈值 → 生成梗概（仅一次，原始 content 保留）
    if (!m.blurSummary && nextScore <= MEMORY_BLUR_THRESHOLD) {
      m.blurSummary = buildBlurSummary(m);
      logger.info(`[Memory] 摘要模糊化: "${m.content.slice(0, 40)}..." → blurSummary: "${m.blurSummary}" (score=${nextScore.toFixed(3)})`);
    }
    // 休眠：达到休眠阈值 → 标记（永不删除 — 铁则1）
    if (nextScore <= MEMORY_HIBERNATE_THRESHOLD && m.hibernated !== true) {
      m.hibernated = true;
      m.hibernatedAt = new Date().toISOString();
      logger.info(`[Memory] 记忆已休眠（记录保留不删除）: "${(m.blurSummary || m.content).slice(0, 40)}..." (score=${nextScore.toFixed(3)})`);
    }
  }

  if (changed) saveMemoryStore(all);
}

/**
 * Phase2 模块4：查询休眠记忆（后台调试接口用；铁则1：只读查询，记录永不删除）。
 * 返回休眠记录（含 blurSummary 梗概），供运维/用户查看被时间淡忘但完整保留的记忆。
 */
export function getHibernatedMemories(userId?: string): Memory[] {
  const all = getMemoryStore();
  return all.filter(m => m.hibernated === true && (!userId || m.userId === userId));
}

/** 休眠记忆统计（后台调试接口用） */
export function countHibernatedMemories(userId?: string): number {
  return getHibernatedMemories(userId).length;
}

// ── Semantic dedup & contradiction detection ──

// Negation patterns in Chinese and English
const NEGATION_PATTERNS = [
  /不[^过论妨仅管只论止断愧外必再会]/u, /没[有想]/u, /别/u, /否/u, /非/u,
  /\bnot\b/i, /\bdon'?t\b/i, /\bnever\b/i, /\bno\b/i, /\bcan'?t\b/i, /\bwon'?t\b/i,
];

// Common polarity-flip pairs: positive → negative
const POLARITY_PAIRS: [RegExp, string][] = [
  [/喜欢|爱|享受|热爱/g, '讨厌|恨|厌恶|反感'],
  [/好|棒|优秀|出色|赞/g, '差|烂|糟糕|坏|垃圾'],
  [/快|迅速|高效/g, '慢|缓慢|拖沓'],
  [/简单|容易/g, '复杂|困难'],
  [/美|漂亮|好看/g, '丑|难看'],
  [/有用|方便|实用/g, '没用|不便|鸡肋'],
  [/开启|打开|启用|使用/g, '关闭|禁用|停用|不用'],
  [/经常|一直|总是/g, '从不|很少|偶尔'],
];

/**
 * Extract key semantic units from text — CJK bigrams + normalized English words,
 * with negation markers preserved for polarity-aware comparison.
 */
function semanticTokens(text: string): { tokens: Set<string>; negated: Set<string> } {
  const base = tokenize(text);
  const tokens = new Set(base);
  const negated = new Set<string>();

  // Detect negated tokens: if a negation word appears within ±3 chars of a token
  const lower = text.toLowerCase();
  for (const negPat of NEGATION_PATTERNS) {
    const match = lower.match(negPat);
    if (match && match.index !== undefined) {
      const negPos = match.index;
      // Mark tokens near the negation as negated
      for (const t of base) {
        const tpos = lower.indexOf(t);
        if (tpos >= 0 && Math.abs(tpos - negPos) <= 8) {
          negated.add(t);
        }
      }
    }
  }

  return { tokens, negated };
}

/** Check if high-overlap texts have opposite polarity (contradiction) */
function hasPolarityConflict(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();

  for (const [posPat, negList] of POLARITY_PAIRS) {
    const negPats = negList.split('|');
    const aHasPos = posPat.test(lowerA);
    const bHasPos = posPat.test(lowerB);

    for (const negStr of negPats) {
      const negRe = new RegExp(negStr, 'g');
      const aHasNeg = negRe.test(lowerA);
      const bHasNeg = negRe.test(lowerB);

      // One text is positive, the other negative → contradiction
      if ((aHasPos && bHasNeg) || (aHasNeg && bHasPos)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Improved content similarity: combines fast lexical overlap with
 * negation-aware semantic comparison. Returns [score, hasContradiction].
 */
function contentSimilarity(a: string, b: string): number {
  const { tokens: tokA, negated: negA } = semanticTokens(a);
  const { tokens: tokB, negated: negB } = semanticTokens(b);
  if (tokA.size === 0 || tokB.size === 0) return 0;

  // Core lexical overlap (Jaccard with negation penalty)
  let overlap = 0;
  let negOverlap = 0;
  for (const w of tokA) {
    if (tokB.has(w)) {
      overlap++;
      // If one side is negated but the other isn't, reduce effective overlap
      if ((negA.has(w) && !negB.has(w)) || (!negA.has(w) && negB.has(w))) {
        negOverlap++;
      }
    }
  }

  const baseScore = overlap / Math.max(tokA.size, tokB.size);
  // Penalize negated overlaps — they indicate opposite meanings
  const penalty = overlap > 0 ? (negOverlap / overlap) * 0.5 : 0;
  return Math.max(0, baseScore - penalty);
}

/** Check if a new memory contradicts any existing memories for the same user */
function findContradictions(
  newContent: string,
  userId: string,
  memType: string,
  existingMemories: Memory[],
): Memory[] {
  const contradictions: Memory[] = [];
  const lower = newContent.toLowerCase();

  for (const existing of existingMemories) {
    if (existing.userId !== userId || existing.type !== memType) continue;

    const sim = contentSimilarity(newContent, existing.content);
    // Only check for contradiction when there's meaningful overlap
    if (sim < 0.35) continue;

    if (hasPolarityConflict(lower, existing.content.toLowerCase())) {
      contradictions.push(existing);
    }
  }

  return contradictions;
}

// ── Cross-Agent Memory Sharing ──

/**
 * Borrow high-value memories from other agents that match the given topic.
 * Only returns memories marked crossAgentShare:true, and respects sharedToAgentIds.
 *
 * This enables the "wisdom of the swarm" — agents learn from each other's
 * crystallized insights without sharing raw episodic context.
 */
export function borrowAgentMemories(
  requestingAgentId: string,
  topic: string,
  userId: string,
  limit: number = 5,
): Memory[] {
  const all = getMemoryStore();
  const topicTokens = new Set(tokenize(topic.toLowerCase()));

  const candidates: Array<{ memory: Memory; score: number }> = [];

  for (const m of all) {
    // Skip own memories
    if (m.agentId === requestingAgentId) continue;
    // Skip if not cross-agent shareable
    if (!m.crossAgentShare) continue;
    // Respect targeted sharing
    if (m.sharedToAgentIds && m.sharedToAgentIds.length > 0) {
      if (!m.sharedToAgentIds.includes(requestingAgentId) && !m.sharedToAgentIds.includes('*')) {
        continue;
      }
    }
    // Must be same user
    if (m.userId !== userId) continue;
    // Only high-tier memories (growth, internalized) are worth borrowing
    if (m.tier !== 'growth' && m.tier !== 'internalized' && m.tier !== 'core_identity') continue;
    // Minimum importance threshold
    if (m.importance < 0.6) continue;

    // Score by topic relevance
    const memTokens = new Set((m.keywords ?? []).map(k => k.toLowerCase()));
    let overlap = 0;
    for (const t of topicTokens) {
      if (memTokens.has(t)) overlap++;
    }
    // Also check content for substring match
    const contentLower = m.content.toLowerCase();
    for (const t of topicTokens) {
      if (contentLower.includes(t)) overlap += 0.5;
    }

    if (overlap > 0) {
      // Weight by tier and importance
      const tierWeight = m.tier === 'core_identity' ? 1.5 : m.tier === 'growth' ? 1.2 : 0.9;
      const score = overlap * tierWeight * m.importance;
      candidates.push({ memory: m, score });
    }
  }

  // Sort by score descending, take top N
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit).map(c => c.memory);
}

/**
 * Auto-mark high-value memories as cross-agent shareable.
 * Called after memory promotion/crystallization.
 * Growth-tier memories and internalized memories with importance > 0.7 get auto-shared.
 */
export function autoMarkCrossAgentShare(userId: string): number {
  const all = getMemoryStore();
  let marked = 0;

  for (const m of all) {
    if (m.userId !== userId) continue;
    if (m.crossAgentShare) continue; // Already marked

    if (m.tier === 'growth') {
      m.crossAgentShare = true;
      marked++;
    } else if (m.tier === 'internalized' && m.importance > 0.7) {
      m.crossAgentShare = true;
      marked++;
    }
  }

  if (marked > 0) saveMemoryStore(all);
  return marked;
}

// ── Helpers ──

function dedupeKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map(k => k.toLowerCase()))].slice(0, 10);
}
