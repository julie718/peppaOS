import path from 'path';
import { logger } from '../lib/logger';
// Phase4: 旧模块 addMemory 直接写入迁移 — 事件封装后经 runInnerTick 统一落库（仅 innerTick.ts 内部允许 addMemory）
import { runInnerTick } from '../../src/core/innerTick';
import type { MentalEventItem } from '../../src/types/innerTickSchema';
// Phase4: 全局功能开关 — 知识文档摄入记忆写入受旧自主逻辑开关控制
import { MIND_SWITCH } from '../../src/config/mindSwitch';
import { Memory } from '../memory/types';
import type { MarkdownKnowledgeMetadata } from '../knowledge/markdown';

export interface ChunkOptions {
  maxChunkSize?: number;
  overlapSize?: number;
  agentId?: string;
}

export interface IngestDocumentOptions {
  chunkSize?: number;
  tier?: 'episodic' | 'internalized';
  filePath?: string;
  domain?: string;
  orgId?: string;
  sourceMetadata?: MarkdownKnowledgeMetadata;
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
 * Each chunk becomes an internalized memory with source citation metadata.
 * Phase4: 原 addMemory 直接写入迁移 — 每个 chunk 封装为 MentalEventItem，任务末尾经 runInnerTick 统一落库，
 * 受 enableOldSchedulerAutonomy 开关控制，开关关闭时整套旧记忆写入逻辑不执行（返回空结果）
 */
export async function ingestDocument(
  userId: string,
  agentId: string,
  documentTitle: string,
  content: string,
  options?: IngestDocumentOptions,
): Promise<{ chunkCount: number; memoryIds: string[] }> {
  if (!MIND_SWITCH.enableOldSchedulerAutonomy) {
    return { chunkCount: 0, memoryIds: [] };
  }

  const chunks = chunkText(content, {
    maxChunkSize: options?.chunkSize || 500,
    agentId,
  });

  const memoryIds: string[] = [];
  // Phase4: 本任务派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
  const eventList: MentalEventItem[] = [];
  const sourceFile = options?.filePath || documentTitle;
  const metadataKeywords = buildSourceMetadataKeywords(options?.sourceMetadata);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem（不直接落库，返回本地派生 id）
    const evt: MentalEventItem = {
      source: 'agent_rag',
      eventType: 'document_ingest',
      brief: `知识文档摄入：${documentTitle}`,
      payload: {
        content: `[${documentTitle} #${i + 1}/${chunks.length}] ${chunk}`,
        keywords: [
          documentTitle,
          `source:${path.basename(sourceFile)}`,
          `chunk:${i + 1}/${chunks.length}`,
          'ingested',
          'document',
          ...metadataKeywords,
        ],
        type: 'knowledge',
        tier: options?.tier || 'internalized',
        perspective: 'peppa_self',
        importance: 0.4,
        agentId,
        domain: options?.domain || 'personal',
        orgId: options?.orgId || '',
        source: 'import',
      },
    };
    eventList.push(evt);
    memoryIds.push(`rag_chunk_${Date.now()}_${i}`);
  }

  // Phase4: 任务末尾派发本任务派生心智事件（非阻塞，失败不影响主流程）
  if (eventList.length > 0) {
    void runInnerTick({ userId, derivedMentalEvents: eventList }).catch((e) => console.error('mental event dispatch fail', e));
  }

  logger.info(`[RAG] Ingested "${documentTitle}" -> ${chunks.length} chunks for agent ${agentId}`);
  return { chunkCount: chunks.length, memoryIds };
}

function buildSourceMetadataKeywords(metadata?: MarkdownKnowledgeMetadata): string[] {
  if (!metadata) return [];
  const values = [
    metadata.title ? `title:${metadata.title}` : '',
    ...metadata.aliases.map(alias => `alias:${alias}`),
    ...metadata.tags.map(tag => `tag:${tag.replace(/^#/, '')}`),
    ...metadata.wikiLinks.map(link => `wikilink:${link}`),
    ...metadata.markdownLinks.map(link => `link:${link}`),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = String(value || '').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result.slice(0, 120);
}

/**
 * Retrieve relevant chunks for a query from agent-scoped knowledge.
 * Each result includes a citation string tracking source document and chunk position.
 */
import { queryMemories } from '../memory/store';

export function retrieveChunks(
  userId: string,
  agentId: string,
  query: string,
  limit = 5,
  scope: { domain?: string; orgId?: string } = {},
): Array<Memory & { citation: string }> {
  const memories = queryMemories({
    userId,
    agentId,
    type: 'knowledge',
    query,
    limit,
    minConfidence: 0.3,
    domain: scope.domain,
    orgId: scope.orgId,
  });

  return memories.map(m => {
    const source = m.sourceInteractionId
      ? path.basename(m.sourceInteractionId)
      : 'unknown';
    const chunkInfo = (m.keywords || []).find((k: string) => k.startsWith('chunk:')) || 'unknown';
    return {
      ...m,
      citation: `[Source: ${source}, ${chunkInfo}]`,
    };
  });
}
