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
}
