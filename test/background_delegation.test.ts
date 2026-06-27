import { describe, expect, it } from 'vitest';
import { buildDelegationAck, shouldDelegateWorkInBackground } from '../server/agents/background_delegation';

const BASE = {
  text: '整理这个案件文件夹并生成代理词和证据目录',
  category: 'command',
  complexity: 'moderate' as const,
  allowToolUse: true,
  clientActionOnly: false,
  selfRepair: false,
  sanctuary: false,
  directDesktop: false,
  prefersSequentialWorkflow: false,
  availableAgentCount: 2,
};

describe('background delegation', () => {
  it('delegates moderate or complex work to background agents', () => {
    const decision = shouldDelegateWorkInBackground(BASE);
    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe('work_complexity_moderate');
  });

  it('honors explicit background delegation preference', () => {
    const decision = shouldDelegateWorkInBackground({
      ...BASE,
      text: '这个不用等，交给子agent后台处理',
      complexity: 'simple',
    });
    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe('explicit_background_preference');
  });

  it('keeps simple foreground chat and visible desktop work in the foreground', () => {
    expect(shouldDelegateWorkInBackground({
      ...BASE,
      text: '你觉得这个想法怎么样',
      category: 'question',
      complexity: 'simple',
    }).shouldDelegate).toBe(false);

    expect(shouldDelegateWorkInBackground({
      ...BASE,
      directDesktop: true,
    }).shouldDelegate).toBe(false);
  });

  it('builds a concise foreground acknowledgement', () => {
    const ack = buildDelegationAck(['法律检索员', '文书整理员'], 'bg_123');
    expect(ack).toContain('法律检索员、文书整理员');
    expect(ack).toContain('bg_123');
    expect(ack).toContain('继续和你聊天');
  });
});
