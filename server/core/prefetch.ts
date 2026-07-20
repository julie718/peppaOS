/**
 * Adaptive Context Injection (ACI) — Prefetch memories and tools in parallel
 * before the LLM call, so they are ready when the prompt is assembled.
 */
import { dualRetrieve } from '../memory/retriever';
import { logger } from '../lib/logger';

interface PrefetchResult {
  memories: Array<{ id: string; content: string; salience: number }>;
  tools: string[];
}

const cache = new Map<string, { result: PrefetchResult; expiry: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Prefetch memories and relevant tools for a user message.
 * Results are cached for 30 seconds to avoid duplicate work on retries.
 */
export async function prefetchForMessage(userMessage: string, userId?: string): Promise<PrefetchResult> {
  const key = simpleHash(userMessage);
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiry) {
    return cached.result;
  }

  const [rankedMemories, toolDeclarations] = await Promise.all([
    dualRetrieve(userMessage, userId || 'default', 3),
    fetchRelevantTools(userMessage),
  ]);

  const result: PrefetchResult = {
    memories: rankedMemories.map(r => ({
      id: r.memory.id,
      content: r.memory.content?.slice(0, 300) || '',
      salience: r.salience,
    })),
    tools: toolDeclarations,
  };

  cache.set(key, { result, expiry: Date.now() + CACHE_TTL_MS });
  logger.debug(`[Prefetch] "${userMessage.slice(0, 40)}" → ${result.memories.length} memories, ${result.tools.length} tools`);
  return result;
}

/** Fetch tool names relevant to the user message */
async function fetchRelevantTools(userMessage: string): Promise<string[]> {
  try {
    const { routeToolsForTurn } = await import('../cognition/tool_router');
    const { toolRegistry } = await import('../tools/registry');
    const route = routeToolsForTurn(userMessage, toolRegistry.getToolDeclarations());
    return route.toolNames.slice(0, 10);
  } catch {
    return [];
  }
}

/** Simple hash function for cache keys — no crypto dependency needed */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}
