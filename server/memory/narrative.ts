import { makeLLMCall, NormalizedMessage } from '../llm/providers';
import { logger } from '../lib/logger';
import { queryMemories, addMemory, getAssociatedMemories } from './store';
import { Memory } from './types';
import { readDB, writeDB } from '../../db_layer';

export interface NarrativeChainResult {
  narrative: string;
  sourceMemoryIds: string[];
  memoryChain: Memory[];
  storedAsMemoryId?: string;
}

const NARRATIVE_PROMPT = `你是一个叙事编织者。请根据以下按时序排列的记忆片段，编织成一段连贯的第一人称中文叙事。

主题：{topic}

记忆片段（按时间顺序）：
{memories}

请以 Peppa 的身份（第一人称"我"）写一段叙事，语气应当温暖、有连接感，展现记忆之间的因果和发展关系。模式参考：
"记得上次我们...后来你...现在终于..."

输出仅包含 JSON 对象，不要有其他内容：
{
  "narrative": "你编织的第一人称中文叙事，3-6句话，语气温暖自然",
  "sourceMemoryIds": ["mem_xxx", "mem_yyy"]
}`;

// ── Narrative Persistence ──

const MAX_NARRATIVES = 5;

interface StoredNarrative {
  id: string;
  topic: string;
  summary: string;
  sourceMemoryIds: string;
  createdAt: string;
  updatedAt: string;
}

function saveNarrative(topic: string, summary: string, sourceIds: string[]): void {
  try {
    const db = readDB();
    const narratives: StoredNarrative[] = db.narratives || [];
    const id = `narr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    narratives.push({ id, topic, summary, sourceMemoryIds: JSON.stringify(sourceIds), createdAt: now, updatedAt: now });
    // Keep max 5 — merge oldest two if exceeded
    if (narratives.length > MAX_NARRATIVES) {
      const merged = mergeNarratives(narratives[0], narratives[1]);
      narratives.splice(0, 2, merged);
    }
    db.narratives = narratives;
    writeDB(db);
  } catch (err: any) {
    logger.warn('[Narrative] Failed to save narrative:', err.message);
  }
}

function mergeNarratives(a: StoredNarrative, b: StoredNarrative): StoredNarrative {
  const mergedIds = [a.sourceMemoryIds, b.sourceMemoryIds]
    .map(s => { try { return JSON.parse(s); } catch { return []; } })
    .flat() as string[];
  return {
    id: a.id,
    topic: `${a.topic}, ${b.topic}`,
    summary: `${a.summary} ${b.summary}`.slice(0, 600),
    sourceMemoryIds: JSON.stringify([...new Set(mergedIds)]),
    createdAt: a.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

/** Simple keyword-overlap topic clustering — no vector dependency */
function clusterTopic(candidate: string, existing: StoredNarrative[]): string | null {
  const words = new Set(candidate.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  for (const n of existing) {
    const existingWords = new Set(n.topic.toLowerCase().split(/\s+/).filter(w => w.length > 1));
    const overlap = [...words].filter(w => existingWords.has(w)).length;
    if (overlap > 2) return n.topic; // merge into existing topic
  }
  return null; // new topic
}

function getRecentNarratives(limit = MAX_NARRATIVES): StoredNarrative[] {
  try {
    const db = readDB();
    return (db.narratives || []).slice(-limit);
  } catch {
    return [];
  }
}

/**
 * Build a narrative chain from related memories.
 * Uses seed retrieval + Hebbian association traversal to find connected memories,
 * then asks the LLM to weave them into a chronological first-person Chinese narrative.
 */
export async function buildNarrativeChain(params: {
  userId: string;
  topic: string;
  limit?: number;
  getDeepSeek: () => any;
  getGemini: () => any;
  getQwen?: () => any;
}): Promise<NarrativeChainResult> {
  const { userId, topic, limit = 10 } = params;

  // 1. Seed retrieval — find memories matching the topic
  const seedMemories = queryMemories({
    userId,
    query: topic,
    limit,
    minConfidence: 0.3,
  });

  if (seedMemories.length === 0) {
    return { narrative: '', sourceMemoryIds: [], memoryChain: [] };
  }

  // 2. Hebbian traversal — collect associated memories
  const allIds = new Set<string>(seedMemories.map(m => m.id));
  const allMemories: Memory[] = [...seedMemories];

  for (const seed of seedMemories) {
    const associated = getAssociatedMemories(seed.id, userId, 0.2);
    for (const am of associated) {
      if (!allIds.has(am.id)) {
        allIds.add(am.id);
        allMemories.push(am);
      }
    }
  }

  // 3. Sort chronologically
  allMemories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Cap at a reasonable number for the LLM
  const chain = allMemories.slice(0, Math.min(20, allMemories.length));

  // 4. Format memory list for LLM
  const memoryList = chain
    .map((m, i) => `[${i + 1}] ${m.createdAt.slice(0, 10)} | [${m.type}] ${m.content}`)
    .join('\n');

  const prompt = NARRATIVE_PROMPT
    .replace('{topic}', topic)
    .replace('{memories}', memoryList);

  const messages: NormalizedMessage[] = [
    { role: 'user', content: prompt },
  ];

  // 5. Call LLM
  try {
    const response = await makeLLMCall(
      messages,
      [],
      { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 512, userId },
      params.getDeepSeek,
      params.getGemini,
      undefined,
      undefined,
      params.getQwen,
    );

    const text = response.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { narrative: '', sourceMemoryIds: [], memoryChain: chain };
    }

    const parsed: { narrative: string; sourceMemoryIds: string[] } = JSON.parse(jsonMatch[0]);

    if (!parsed.narrative || typeof parsed.narrative !== 'string') {
      return { narrative: '', sourceMemoryIds: [], memoryChain: chain };
    }

    const sourceIds: string[] = Array.isArray(parsed.sourceMemoryIds)
      ? parsed.sourceMemoryIds
      : chain.map(m => m.id);

    // 6. Persist to narratives table
    saveNarrative(topic, parsed.narrative.trim().slice(0, 500), sourceIds);
    logger.info(`[Narrative] built narrative for topic: ${topic}`);

    // 7. Store narrative as a growth memory
    const stored = addMemory(
      {
        userId,
        type: 'knowledge',
        content: `[Narrative re: ${topic}] ${parsed.narrative.trim().slice(0, 500)}`,
        keywords: [topic.toLowerCase(), 'narrative', 'growth', 'story'],
        confidence: 0.85,
        sourceInteractionId: '',
      },
      {
        tier: 'growth',
        perspective: 'peppa_self',
        importance: 0.6,
      },
    );

    return {
      narrative: parsed.narrative.trim(),
      sourceMemoryIds: sourceIds,
      memoryChain: chain,
      storedAsMemoryId: stored.id,
    };
  } catch (err: any) {
    logger.error('[Memory] Narrative chain generation failed:', err.message);
    return {
      narrative: '',
      sourceMemoryIds: [],
      memoryChain: chain,
    };
  }
}

/**
 * Scan last 7 days of memories, cluster by keyword overlap, build narratives for each topic.
 * Called by consolidator after episodic consolidation.
 */
export async function buildNarrativesForRecentTopics(params: {
  userId: string;
  getDeepSeek: () => any;
  getGemini: () => any;
  getQwen?: () => any;
}): Promise<string[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentMemories = queryMemories({
    userId: params.userId,
    limit: 100,
    minConfidence: 0.3,
  }).filter(m => m.createdAt >= sevenDaysAgo);

  if (recentMemories.length < 6) return [];

  // Cluster by keyword overlap
  const topics = new Map<string, Memory[]>();
  const existingNarratives = getRecentNarratives();

  for (const mem of recentMemories) {
    const keywords = (mem.keywords || []).join(' ');
    const existingTopic = clusterTopic(keywords, existingNarratives);
    const topic = existingTopic || keywords.slice(0, 80) || 'general';
    if (!topics.has(topic)) topics.set(topic, []);
    topics.get(topic)!.push(mem);
  }

  // Filter: only topics with >= 3 memories
  const viable = [...topics.entries()].filter(([_, mems]) => mems.length >= 3);
  if (viable.length === 0) return [];

  const built: string[] = [];
  // Limit to max 3 new narratives per cycle
  for (const [topic] of viable.slice(0, 3)) {
    try {
      const result = await Promise.race([
        buildNarrativeChain({
          userId: params.userId,
          topic,
          limit: 10,
          getDeepSeek: params.getDeepSeek,
          getGemini: params.getGemini,
          getQwen: params.getQwen,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
      if (result?.narrative) built.push(topic);
    } catch (err: any) {
      logger.warn('[Narrative] build failed for topic:', topic, err.message);
    }
  }

  if (built.length > 0) {
    logger.info(`[Narrative] built ${built.length} narratives for topics: ${built.join(', ')}`);
  }
  return built;
}
