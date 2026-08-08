import { describe, expect, it } from 'vitest';
import { buildDelegationAck, shouldDelegateWorkInBackground } from '../server/agents/background_delegation';

const BASE = {
  text: '整理这个案件文件夹并生成代理词和证据目录',
  category: 'command',
  complexity: 'moderate' as const,
  allowToolUse: true,
  sanctuary: false,
  availableAgentCount: 2,
};

describe('background delegation (心智驱动)', () => {
  it('delegates moderate or complex work to background agents', () => {
    const decision = shouldDelegateWorkInBackground(BASE);
    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe('work_complexity_moderate');
  });

  it('honors explicit background preference entity (entities.background)', () => {
    const decision = shouldDelegateWorkInBackground({ ...BASE, complexity: 'simple', explicitBackground: true });
    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe('explicit_background_preference');
  });

  it('keeps simple foreground chat in the foreground', () => {
    expect(shouldDelegateWorkInBackground({
      ...BASE,
      text: '你觉得这个想法怎么样',
      category: 'question',
      complexity: 'simple',
    }).shouldDelegate).toBe(false);
  });

  it('does not delegate when tools are disabled, in sanctuary, or without workers', () => {
    expect(shouldDelegateWorkInBackground({ ...BASE, allowToolUse: false }).shouldDelegate).toBe(false);
    expect(shouldDelegateWorkInBackground({ ...BASE, sanctuary: true }).shouldDelegate).toBe(false);
    expect(shouldDelegateWorkInBackground({ ...BASE, availableAgentCount: 0 }).shouldDelegate).toBe(false);
  });

  it('does not delegate non-work categories', () => {
    expect(shouldDelegateWorkInBackground({ ...BASE, category: 'conversation', complexity: 'complex' }).shouldDelegate).toBe(false);
  });

  it('rejects empty input', () => {
    expect(shouldDelegateWorkInBackground({ ...BASE, text: '  ' }).shouldDelegate).toBe(false);
  });

  it('builds a data-driven foreground acknowledgement', () => {
    const ack = buildDelegationAck(['法律检索员', '文书整理员'], 'bg_123');
    expect(ack).toContain('后台任务已启动');
    expect(ack).toContain('法律检索员、文书整理员');
    expect(ack).toContain('bg_123');
  });
});
