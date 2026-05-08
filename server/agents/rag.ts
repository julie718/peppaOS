import { addMemory } from '../memory/store';
import { Memory } from '../memory/types';

export interface ChunkOptions {
  maxChunkSize?: number;
  overlapSize?: number;
  agentId?: string;
}

/**
 * Split text into overlapping chunks for memory ingestion.
 * Default chunk size ~500 chars with 50 char overlap.
 */
export function chunkText(
  text: string,
  options: ChunkOptions = {},
): string[] {
  const maxSize = options.maxChunkSize || 500;
  const overlap = options.overlapSize || 50;
  const chunks: string[] = [];

  let offset = 0;
  while (offset < text.length) {
    const chunk = text.slice(offset, offset + maxSize).trim();
    if (chunk) chunks.push(chunk);
    offset += maxSize - overlap;
  }

  return chunks;
}

/**
 * Ingest a document into an agent's private memory.
 * Each chunk becomes an `episodic` or `internalized` memory
 * with the agent's ID so it's scoped to that agent.
 */
export async function ingestDocument(
  userId: string,
  agentId: string,
  documentTitle: string,
  content: string,
  options?: { chunkSize?: number; tier?: 'episodic' | 'internalized' },
): Promise<{ chunkCount: number; memoryIds: string[] }> {
  const chunks = chunkText(content, {
    maxChunkSize: options?.chunkSize || 500,
    agentId,
  });

  const memoryIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const mem = addMemory(
      {
        userId,
        type: 'knowledge',
        content: `[${documentTitle} #${i + 1}/${chunks.length}] ${chunk}`,
        keywords: [documentTitle, 'ingested', 'document', `chunk_${i}`],
        confidence: 0.7,
        sourceInteractionId: '',
      },
      {
        tier: options?.tier || 'internalized',
        perspective: 'lumi_self',
        importance: 0.4,
        agentId,
      },
    );
    memoryIds.push(mem.id);
  }

  console.log(`[RAG] Ingested "${documentTitle}" → ${chunks.length} chunks for agent ${agentId}`);
  return { chunkCount: chunks.length, memoryIds };
}

/**
 * Retrieve relevant chunks for a query from agent-scoped knowledge.
 */
import { queryMemories } from '../memory/store';

export function retrieveChunks(
  userId: string,
  agentId: string,
  query: string,
  limit = 5,
): Memory[] {
  return queryMemories({
    userId,
    agentId,
    type: 'knowledge',
    query,
    limit,
    minConfidence: 0.3,
  });
}
