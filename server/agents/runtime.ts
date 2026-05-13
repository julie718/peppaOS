import { PersonalityConfig } from '../personality/types';
import { EmotionalState, createDefaultEmotionalState, loadEmotionalState, saveEmotionalState, updateEmotionalState } from '../personality/state';
import { queryMemories, addMemory } from '../memory/store';
import { Memory } from '../memory/types';

export interface AgentRecord {
  id: string;
  name: string;
  category: string;
  config: string;
  data: string;
  createdAt: string;
  ownerUid?: string;
  userId?: string;
  status: string;
  /** REMOVED: personalityId — agents no longer bind to a personality.
   *  Lumi is the sole orchestrator; worker agents are limbs. */
  personalityId?: string;
  modelPreference: string;
  memoryScope: 'shared' | 'private';
  autonomyLevel: 'reactive' | 'scheduled' | 'autonomous';
  runtimeConfig: string;
  /** Skill tags for worker matching (Phase 2.3) */
  skillTags?: string[];
  /** Default execution mode when this agent receives a sub-task */
  executionMode?: string;
  /** Knowledge domain tags for RAG routing */
  knowledgeDomains?: string[];
  /** Whether this agent's memories can be borrowed by other agents */
  allowCrossPollination?: boolean;
  /** Territory mode: 'open' = normal agent, 'sanctuary' = confined memory avatar */
  territory?: 'open' | 'sanctuary';
  /** Source of distillation (chat_records / documents / manual) */
  distilledFrom?: string;
  /** Evidence grading records for distilled memories */
  evidenceMap?: Array<{ memoryIndex: number; grade: 'verbatim' | 'artifact' | 'impression'; source: string }>;
  /** Inferred relationship type (family / close_friend / lover / mentor / colleague) */
  relationshipType?: string;
  /** Whether personality evolution is frozen (default true for sanctuary agents) */
  isFrozen?: boolean;
  /** IDs of initial seed memories created during distillation */
  seedMemoryIds?: string[];
}

export interface AgentTickResult {
  message: string | null;
  memoryUpdate: boolean;
  emotionUpdate: boolean;
}

/**
 * Runtime instance for a single agent.
 * Manages that agent's personality, private/shared memories,
 * emotional state, and autonomous tick logic.
 */
export class AgentRuntime {
  agentId: string;
  agentRecord: AgentRecord;
  personality: PersonalityConfig;
  emotionalState: EmotionalState;

  constructor(
    agentRecord: AgentRecord,
    personality?: PersonalityConfig,
  ) {
    this.agentId = agentRecord.id;
    this.agentRecord = agentRecord;
    this.personality = personality || ({} as PersonalityConfig);
    this.emotionalState = createDefaultEmotionalState();
  }

  /** Load agent-specific state (emotion, etc.) */
  loadState(userId: string): void {
    // Agent emotional state keyed by agentId
    this.emotionalState = loadEmotionalState(`${userId}_agent_${this.agentId}`);
  }

  /** Save agent-specific state */
  saveState(userId: string): void {
    saveEmotionalState(`${userId}_agent_${this.agentId}`, this.emotionalState);
  }

  /** Query memories filtered by this agent's memoryScope */
  queryMemories(query: string, limit = 5): Memory[] {
    const filters: any = {
      userId: this.agentRecord.ownerUid || this.agentRecord.userId || '',
      query,
      limit,
      minConfidence: 0.3,
    };
    if (this.agentRecord.memoryScope === 'private') {
      (filters as any).agentId = this.agentId;
    }
    return queryMemories(filters);
  }

  /** Add a memory scoped to this agent */
  addMemory(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'lastRetrievedAt' | 'retrieveCount' | 'tier' | 'perspective' | 'importance' | 'parentId'> & { tier?: Memory['tier']; perspective?: Memory['perspective'] }): Memory {
    return addMemory(
      {
        ...memory,
        userId: this.agentRecord.ownerUid || this.agentRecord.userId || '',
      } as any,
      {
        tier: memory.tier || 'episodic',
        perspective: memory.perspective || 'lumi_self',
        importance: (memory as any).importance || 0.3,
      },
    );
  }

  /** Update emotional state after an interaction */
  updateEmotion(eventType: 'interaction' | 'novel_topic' | 'positive_feedback' | 'negative_feedback', userId: string): void {
    this.emotionalState = updateEmotionalState(this.emotionalState, {
      type: eventType,
      userId,
      timestamp: new Date().toISOString(),
    });
    this.saveState(userId);
  }

  /**
   * Autonomous tick — generates a proactive message if the agent's autonomy
   * level allows and the emotional/context state warrants it.
   */
  async autonomousTick(
    userId: string,
    recentMemories: Memory[],
  ): Promise<AgentTickResult> {
    if (this.agentRecord.autonomyLevel === 'reactive') {
      return { message: null, memoryUpdate: false, emotionUpdate: false };
    }

    // Recover energy over time (idle recovery)
    this.emotionalState = updateEmotionalState(this.emotionalState, {
      type: 'idle_recovery',
    });

    // Only generate proactive messages if curiosity + energy are high enough
    const shouldSpeak =
      this.agentRecord.autonomyLevel === 'autonomous' ||
      (this.emotionalState.curiosity > 0.6 && this.emotionalState.energy > 0.4);

    if (!shouldSpeak || recentMemories.length === 0) {
      this.saveState(userId);
      return { message: null, memoryUpdate: false, emotionUpdate: true };
    }

    // Build a reflective prompt from recent memories
    const memoryHints = recentMemories.slice(0, 3)
      .map(m => `- ${m.content.slice(0, 150)}`)
      .join('\n');

    const message = `I've been reflecting on recent events and wanted to check in. Here's what's on my mind:\n\n${memoryHints}\n\nHow are things going on your end?`;

    this.emotionalState.curiosity = Math.max(0.1, this.emotionalState.curiosity - 0.1);
    this.saveState(userId);

    return { message, memoryUpdate: false, emotionUpdate: true };
  }

  /** Export the current runtime config for persistence */
  exportRuntimeConfig(): string {
    return JSON.stringify({
      lastAutonomousTick: new Date().toISOString(),
      emotionalState: this.emotionalState,
    });
  }
}
