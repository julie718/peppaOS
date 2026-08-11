// src/types/innerTickSchema.ts
// 阶段1：InnerTick 独立心智回合 — 结构化输出类型定义
// 约束：id 使用 uuid v4；intensity 限定 0-1 浮点数。
// 本文件为纯类型声明，不包含任何运行时逻辑。

/** 情绪状态：name 为情绪名，intensity 限定 0-1 */
export interface InnerTickMood {
  name: string;
  intensity: number; // 0-1 浮点数
}

/** 欲望条目：状态 active（活跃）/ archived（已归档） */
export interface InnerTickDesire {
  id: string; // uuid v4
  content: string;
  intensity: number; // 0-1 浮点数
  status: 'active' | 'archived';
}

/** 目标条目：active / suspended / finished / archived */
export interface InnerTickGoal {
  id: string; // uuid v4
  content: string;
  status: 'active' | 'suspended' | 'finished' | 'archived';
}

/** 注意力焦点条目 */
export interface InnerTickFocus {
  id: string; // uuid v4
  content: string;
}

/** 归档条目：标记不再活跃的目标/欲望，交由系统写入向量记忆 */
export interface InnerTickArchiveItem {
  type: 'desire' | 'goal';
  id: string; // 对应 desires / goals 列表中的 id
  reason: string;
}

/**
 * 派生心智事件：旧模块（scheduler / idle_brain / dream / consolidator 等）不再直接
 * 调用 addMemory 写向量记忆，而是把原 addMemory 载荷封装为 MentalEventItem 事件，
 * 收集后在模块任务末尾随 runInnerTick({ derivedMentalEvents }) 注入 LLM 推演上下文。
 * 实际落库统一收敛到 InnerTick 内部（全系统仅 innerTick.ts 允许调用 addMemory）。
 */
export interface MentalEventItem {
  source: string; // scheduler / idle_brain / dream / consolidator 等模块来源
  eventType: string;
  brief: string; // 简短文本描述事件
  payload: Record<string, any>;
}

// ─────────────────────────────────────────────
// P2迁移：LLM 心智推演输出扩展字段（情绪/欲望/人格/关系 演化事件）
// 开启 p2MigrateEnable 后，这些字段由 LLM 推演生成，经
// runInnerTick → MentalEventItem → paradigmGuard 守卫校验后统一落库到业务状态表。
// 开关关闭时字段仅为快照观测内容，不触发任何写库。
// ─────────────────────────────────────────────

/** 情绪漂移事件：本轮推演出的情绪变化（name 情绪名 / intensity 0-1 / change -1~1 相对上一轮变化量） */
export interface InnerTickEmotionDrift {
  name: string;
  intensity: number; // 0-1 浮点数（推演后的目标情绪强度）
  change: number;    // -1 ~ 1（相对上一轮的变化量，用于日志/观测）
}

/** 欲望演化事件：本轮推演出的欲望生成/衰减/归档（id 缺省或无法解析时为「新增」） */
export interface InnerTickDesireEvolve {
  id?: string;             // 已存在欲望的 uuid（可空：空=新欲望）
  content: string;         // 欲望内容
  intensity: number;       // 0-1 浮点数（新欲望初始强度 / 已有欲望的目标强度）
  status: 'active' | 'archived' | 'abandoned' | 'completed'; // active=生成，其余=衰减/归档
  priorityDelta?: number;  // 已有欲望的优先级增量 -1 ~ 1（衰减/提升）
}

/** 人格漂移事件：本轮推演出的人格缓慢演化（8 维 delta，每维 -0.02 ~ +0.02，禁止剧烈突变） */
export interface InnerTickPersonalityDrift {
  delta: number[]; // 8 维增量，每维限制 -0.02 ~ +0.02（与旧 personality.updatePersonality 同一约定）
}

/** 关系调整事件：本轮推演出的关系状态调整（4 维目标向量：信任/亲密/理解/依赖） */
export interface InnerTickRelationshipAdjustment {
  vector: number[]; // 4 维目标向量（0-1），与 relationship_state.vector_json 同构
}

/**
 * InnerTick 心智回合完整结构化输出。
 * runInnerTick() 返回本对象，并将完整序列化写入 life.db 快照备份；
 * 本阶段不据此修改任何全局运行状态。
 */
export interface InnerTickOutput {
  thought: string;
  mood: InnerTickMood;
  desires: InnerTickDesire[];
  goals: InnerTickGoal[];
  focus: InnerTickFocus[];
  archiveItems: InnerTickArchiveItem[];
  triggerInnerTick: boolean;
  memoryHints: string[];
  // ── P2迁移：LLM 心智推演演化事件（可选字段；p2MigrateEnable 开启时经守卫统一落库业务状态表）──
  emotionDrift?: InnerTickEmotionDrift;            // 情绪漂移 → emotions
  desireEvolve?: InnerTickDesireEvolve[];          // 欲望生成/衰减 → desires
  personalityDrift?: InnerTickPersonalityDrift;    // 人格缓慢演化 → personality
  relationshipAdjustment?: InnerTickRelationshipAdjustment; // 关系调整 → relationship_state
}
