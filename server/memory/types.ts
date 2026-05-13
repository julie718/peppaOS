export type MemoryType = 'preference' | 'fact' | 'habit' | 'knowledge';

/** Memory hierarchy tier — determines decay rate and retrieval priority */
export type MemoryTier = 'episodic'       // Raw conversation memories, fast decay
                       | 'internalized'  // Internalized preferences (Lumi's own)
                       | 'growth'        // Growth narratives, LLM-consolidated
                       | 'core_identity';// Core identity, never decays, protected

/** Whose perspective does this memory belong to */
export type MemoryPerspective = 'owner_trait'   // About the owner's traits
                              | 'lumi_self'     // Lumi's self-knowledge
                              | 'shared_memory' // "Our" shared experiences
                              | 'lumi_growth';  // Lumi's growth milestones

/** Tree node type — branch nodes are topic containers, leaves are actual memories */
export type MemoryNodeType = 'branch' | 'leaf';

export interface Memory {
  id: string;
  userId: string;
  type: MemoryType;
  /** The memory text, e.g. "User prefers concise answers" */
  content: string;
  /** Normalized keywords for retrieval matching */
  keywords: string[];
  /** 0–1 confidence. Repeated confirmations raise it, contradictions lower it. */
  confidence: number;
  /** Interaction ID that produced this memory */
  sourceInteractionId: string;
  createdAt: string;
  updatedAt: string;
  lastRetrievedAt: string | null;
  retrieveCount: number;
  /** Memory hierarchy tier */
  tier: MemoryTier;
  /** Whose perspective */
  perspective: MemoryPerspective;
  /** 0–1 importance — separate from confidence. Core identity has 0.9+ */
  importance: number;
  /** Points to parent node in the memory tree, null if root */
  parentId: string | null;
  /** Agent ID for agent-private memories. Empty string = shared */
  agentId: string;
  /** Tree node type: 'branch' = topic container, 'leaf' = content memory. Default 'leaf' */
  nodeType: MemoryNodeType;
}

export interface MemoryTree {
  node: Memory;
  children: MemoryTree[];
}

export interface MemoryQuery {
  userId?: string;
  /** Free-text search — matched against keywords and content */
  query?: string;
  type?: MemoryType;
  limit?: number;
  minConfidence?: number;
  tier?: MemoryTier;
  perspective?: MemoryPerspective;
  minImportance?: number;
  /** Only return memories without parentId (unconsolidated originals) */
  unconsolidatedOnly?: boolean;
  /** Filter by agent ID (empty string matches shared memories) */
  agentId?: string;
  /** Filter by parent node — null = root only, string = children of that node */
  parentId?: string | null;
  /** Filter by node type */
  nodeType?: MemoryNodeType;
  /** ISO 8601 cutoff — only return memories created on or before this date */
  before?: string;
  /** Personality vector for retrieval biasing — higher warmth prefers shared/personal memories */
  personalityVector?: { cognitiveStyle: Record<string,number>; socialStyle: Record<string,number> };
  /** Pre-computed type weights from vectorMemoryBias() */
  retrievalTypeWeights?: Record<string, number>;
  /** Pre-computed perspective weights from vectorMemoryBias() */
  retrievalPerspectiveWeights?: Record<string, number>;
}

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
  keywords: string[];
  confidence: number;
}
