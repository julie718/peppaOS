export type MemoryType = 'preference' | 'fact' | 'habit' | 'knowledge';

/** Memory hierarchy tier — determines decay rate and retrieval priority */
export type MemoryTier = 'episodic'       // Raw conversation memories, fast decay
                       | 'internalized'  // Internalized preferences (Peppa's own)
                       | 'growth'        // Growth narratives, LLM-consolidated
                       | 'core_identity';// Core identity, never decays, protected

/** Whose perspective does this memory belong to */
export type MemoryPerspective = 'owner_trait'   // About the owner's traits
                              | 'peppa_self'     // Peppa's self-knowledge
                              | 'shared_memory' // "Our" shared experiences
                              | 'peppa_growth';  // Peppa's growth milestones

export type MemorySource = 'chat' | 'voice' | 'runtime_log' | 'meeting' | 'manual' | 'organization' | 'lap' | 'community' | 'external_app' | 'system' | 'import' | 'consolidation';
export type MemoryPrivacyClass = 'private' | 'organization' | 'shared' | 'public' | 'secret';
export type MemoryRetention = 'ephemeral' | 'session' | 'long_term' | 'permanent';

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
  /** Whether this memory can be borrowed by other agents (cross-agent sharing) */
  crossAgentShare?: boolean;
  /** Specific agent IDs this memory is shared with. Empty = all agents can borrow. */
  sharedToAgentIds?: string[];
  /** Location where this memory was formed (e.g. 'home', 'office', 'cafe', 'mobile') */
  location?: string;
  /** 1536-dimension embedding vector from text-embedding-3-small for semantic search */
  embedding?: number[];
  /** Domain: personal or work */
  domain?: string;
  /** Organization ID (work domain only) */
  orgId?: string;
  /** Source surface that created this memory. Used by the global Memory Firewall. */
  source?: MemorySource;
  /** Privacy class assigned by Memory Firewall. */
  privacyClass?: MemoryPrivacyClass;
  /** Retention policy assigned by Memory Firewall. */
  retention?: MemoryRetention;
  /** Whether the user explicitly approved this memory for protected/permanent storage. */
  userApproved?: boolean;
  /** Firewall decision that admitted the memory. */
  firewall?: {
    accepted: boolean;
    reason: string;
    appliedAt: string;
  };
  // ── Phase2 模块4：长期记忆权重衰减 ──
  /** 记忆权重 0-1（默认 1.0 满权重）。随时间衰减；检索强化回补；core_identity 永不衰减。
   *  旧数据无此字段 → 按 1.0 处理（getMemoryScore 归一化）。 */
  score?: number;
  /** 是否已休眠（权重衰减至 MEMORY_HIBERNATE_THRESHOLD 以下）。
   *  仅标记，数据库记录永不物理删除（铁则1），后台接口可查询。 */
  hibernated?: boolean;
  /** 休眠时间（ISO 8601；未休眠为 null/缺省） */
  hibernatedAt?: string | null;
  /** 摘要模糊化梗概：低分记忆（≤ MEMORY_BLUR_THRESHOLD）的模糊压缩摘要，
   *  保留核心梗概（类型+首句+关键词），细节模糊；原始 content 完整保留不删除。 */
  blurSummary?: string | null;
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
  /** ISO 8601 cutoff — only return memories created on or after this date */
  after?: string;
  /** Filter by location tag (e.g. 'home', 'office', 'cafe') */
  location?: string;
  /** Personality vector for retrieval biasing — higher warmth prefers shared/personal memories */
  personalityVector?: { cognitiveStyle: Record<string,number>; socialStyle: Record<string,number> };
  /** Pre-computed type weights from vectorMemoryBias() */
  retrievalTypeWeights?: Record<string, number>;
  /** Pre-computed perspective weights from vectorMemoryBias() */
  retrievalPerspectiveWeights?: Record<string, number>;
  /** Enable vector semantic search via embedding cosine similarity */
  useVector?: boolean;
  /** P0-5: 只读检索 — 不把命中记忆标记为"已检索"（GC 等内部巡检用，
      避免巡检动作本身刷新 lastRetrievedAt 导致低频降权永远无法触发） */
  noTouch?: boolean;
  /** Phase2 模块4：是否包含休眠记忆（默认 false = 日常检索排除休眠记录；
      后台调试接口传 true 查询全部记录，铁则1：记录永不删除） */
  includeHibernated?: boolean;
  /** Filter by domain */
  domain?: string;
  /** Filter by organization ID */
  orgId?: string;
}

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
  keywords: string[];
  confidence: number;
}
