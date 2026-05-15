/**
 * Enterprise Knowledge Base — CRUD, chunking, embedding, semantic search.
 *
 * Embeds articles using the cheapest available LLM provider and stores
 * embeddings as JSON arrays in enterprise_kb_embeddings. Search uses
 * in-memory cosine similarity (no vector DB dependency).
 */

import * as EDB from './db';
import { logAudit } from './db';
import { generateEmbedding, cosineSimilarity } from '../memory/store';

// ── Article CRUD ─────────────────────────────────────────────────────────

export function listArticles(orgId: string, filters?: { category?: string; status?: string }) {
  return EDB.listKbArticles(orgId, filters);
}

export function getArticle(orgId: string, articleId: string) {
  return EDB.getKbArticle(orgId, articleId);
}

export function createArticle(
  orgId: string,
  authorId: string,
  data: { title: string; content: string; category?: string; tags?: string[]; status?: 'draft' | 'published' }
) {
  const article = EDB.createKbArticle(orgId, authorId, data);
  logAudit({
    orgId,
    userId: authorId,
    action: 'kb.article.create',
    resourceType: 'kb_article',
    resourceId: article.id,
    details: { title: data.title },
  });
  // Fire-and-forget indexing
  indexArticle(orgId, article.id).catch(err => {
    console.error(`[KB] Failed to index article ${article.id}:`, err.message);
  });
  return article;
}

export function updateArticle(
  orgId: string,
  userId: string,
  articleId: string,
  updates: { title?: string; content?: string; category?: string; tags?: string[]; status?: 'draft' | 'published' | 'archived' }
) {
  const dbUpdates: any = { ...updates };
  if (updates.tags) dbUpdates.tags = JSON.stringify(updates.tags);
  const article = EDB.updateKbArticle(orgId, articleId, dbUpdates);
  if (article) {
    logAudit({
      orgId,
      userId,
      action: 'kb.article.update',
      resourceType: 'kb_article',
      resourceId: articleId,
      details: updates,
    });
    // Re-index if content changed
    if (updates.content) {
      EDB.deleteKbEmbeddings(articleId);
      indexArticle(orgId, articleId).catch(err => {
        console.error(`[KB] Failed to re-index article ${articleId}:`, err.message);
      });
    }
  }
  return article;
}

export function deleteArticle(orgId: string, userId: string, articleId: string) {
  const result = EDB.deleteKbArticle(orgId, articleId);
  if (result) {
    logAudit({
      orgId,
      userId,
      action: 'kb.article.delete',
      resourceType: 'kb_article',
      resourceId: articleId,
    });
  }
  return result;
}

// ── Chunking ─────────────────────────────────────────────────────────────

const CHUNK_SIZE = 500; // characters
const CHUNK_OVERLAP = 100;

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    // Try to break at a sentence boundary (。！？\n)
    let breakPoint = end;
    if (end < text.length) {
      const searchEnd = Math.min(end + 50, text.length);
      const slice = text.slice(end - 50, searchEnd);
      const match = slice.match(/[。！？\n]/);
      if (match && match.index !== undefined) {
        breakPoint = end - 50 + match.index + 1;
      }
    }
    chunks.push(text.slice(start, breakPoint).trim());
    start = breakPoint - CHUNK_OVERLAP;
    if (start < 0) start = 0;
  }
  return chunks.filter(c => c.length > 10);
}

// ── Indexing ─────────────────────────────────────────────────────────────

export async function indexArticle(orgId: string, articleId: string): Promise<number> {
  const article = EDB.getKbArticle(orgId, articleId);
  if (!article) return 0;

  // Remove existing embeddings
  EDB.deleteKbEmbeddings(articleId);

  const chunks = chunkText(article.content);
  if (chunks.length === 0) return 0;

  let indexed = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const embedding = await generateEmbedding(chunks[i]);
      if (embedding) {
        EDB.saveKbEmbedding(articleId, i, embedding, chunks[i]);
        indexed++;
      }
      // Rate-limit: small delay between batches
      if (i > 0 && i % 5 === 0) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err) {
      console.error(`[KB] Failed to embed chunk ${i} of article ${articleId}:`, err);
    }
  }

  if (indexed > 0) {
    logAudit({
      orgId,
      userId: article.authorId,
      action: 'kb.article.index',
      resourceType: 'kb_article',
      resourceId: articleId,
      details: { chunks: chunks.length, indexed },
    });
  }

  return indexed;
}

// ── Search ───────────────────────────────────────────────────────────────

export async function searchKnowledgeBase(
  orgId: string,
  query: string,
  limit: number = 5
): Promise<Array<{ articleId: string; title: string; chunk: string; score: number }>> {
  const allEmbeddings = EDB.getAllKbEmbeddings(orgId);
  if (allEmbeddings.length === 0) return [];

  // Generate query embedding
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch {
    return []; // can't embed query, return empty
  }
  if (!queryEmbedding) return [];

  // Score every chunk by cosine similarity
  const scored = allEmbeddings
    .map(emb => {
      let embeddingArr: number[];
      try {
        embeddingArr = JSON.parse(emb.embedding);
      } catch {
        return null;
      }
      const score = cosineSimilarity(queryEmbedding!, embeddingArr);
      return { ...emb, score };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null && s.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Enrich with article title
  const articleIds = [...new Set(scored.map(s => s.articleId))];
  const articles = articleIds
    .map(id => EDB.getKbArticle(orgId, id))
    .filter(Boolean);

  return scored.map(s => {
    const article = articles.find(a => a!.id === s.articleId);
    return {
      articleId: s.articleId,
      title: article?.title || '(unknown)',
      chunk: s.content,
      score: s.score,
    };
  });
}
