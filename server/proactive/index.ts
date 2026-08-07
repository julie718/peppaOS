import { logger } from '../lib/logger';
import { allTriggers } from './triggers';
import { emitProactivePush } from '../lib/pushService';

export type ProactiveScene =
  | 'morning_greeting'
  | 'long_silence'
  | 'memory_trigger'
  | 'health_perception'
  | 'emotion_share'
  // L-11: 低情绪安慰 + 低活跃度问候
  | 'low_mood_comfort'
  | 'low_activity_greeting'
  // 阶段一·模块2: 行程临近批量拉取出行信息推送
  | 'travel_upcoming';

export interface TriggerResult {
  triggered: boolean;
  scene?: ProactiveScene;
  content?: string;
  reason?: string;
}

export interface ProactiveTrigger {
  name: string;
  check: () => Promise<TriggerResult>;
}

export class ProactiveManager {
  private triggers: ProactiveTrigger[] = [];
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    for (const trigger of allTriggers) {
      this.register(trigger);
    }
    this.initialized = true;
    logger.info(`[Proactive] 已初始化，注册了 ${this.triggers.length} 个触发器`);
  }

  register(trigger: ProactiveTrigger): void {
    this.triggers.push(trigger);
    logger.info(`[Proactive] 注册触发器: ${trigger.name}`);
  }

  async run(): Promise<void> {
    if (!this.initialized) {
      this.init();
    }
    for (const trigger of this.triggers) {
      try {
        const result = await trigger.check();
        if (result.triggered) {
          logger.info(`[Proactive] 触发: ${result.scene} - ${result.reason}`);

          const pushed = emitProactivePush({
            scene: result.scene!,
            content: result.content || '主动触发了一条消息',
            reason: result.reason,
          });

          if (pushed) {
            logger.info(`[Proactive] ✅ 推送成功: ${result.scene}`);
          } else {
            logger.warn(`[Proactive] ⚠️ 推送失败: IO未就绪`);
          }
        }
      } catch (e) {
        logger.error(`[Proactive] 触发器 ${trigger.name} 执行失败: ${e}`);
      }
    }
  }
}

export const proactiveManager = new ProactiveManager();
