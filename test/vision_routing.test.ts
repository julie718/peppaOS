import { describe, expect, it } from 'vitest';
import { hasVisionIntent } from '../server/cognition/vision_routing';

describe('vision routing (数据层视觉信号)', () => {
  it('detects image/screenshot file paths (客观数据形态)', () => {
    expect(hasVisionIntent('请分析 C:\\Users\\me\\Desktop\\plan.png')).toBe(true);
    expect(hasVisionIntent('/tmp/screenshot.jpg 帮我看看')).toBe(true);
    expect(hasVisionIntent('识别这张图片 https://example.com/photo.webp')).toBe(true);
  });

  it('does not guess visual intent from language (意图由心智内核判定)', () => {
    expect(hasVisionIntent('帮我识别一下屏幕上的内容')).toBe(false);
    expect(hasVisionIntent('read this screenshot')).toBe(false);
    expect(hasVisionIntent('你觉得这个想法怎么样')).toBe(false);
    expect(hasVisionIntent('')).toBe(false);
  });
});
