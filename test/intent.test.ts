import { describe, it, expect } from 'vitest';
import { classifyIntent, classifyIntentLLM, extractSentiment, IntentResult } from '../server/cognition/intent';

/** 心智分类器测试桩：给定 LLM 返回的 JSON，验证分类结果映射/实体/情绪/缓存/兜底 */
function llmResponding(json: string): (prompt: string, userText: string) => Promise<string> {
  return async () => json;
}

const base: IntentResult = { category: 'unknown', confidence: 0.3, entities: {}, needsLLM: true };

describe('Intent Classifier (LLM 心智分类器)', () => {
  it('parses category + confidence + subIntent from LLM JSON', async () => {
    const r = await classifyIntentLLM('放首歌来听听', base, llmResponding(
      '{"category":"command","confidence":0.92,"subIntent":"play","entities":{"music":"放首歌来听听"},"sentiment":{"valence":0.5,"urgency":0.1,"frustration":0}}',
    ));
    expect(r.category).toBe('command');
    expect(r.subIntent).toBe('play');
    expect(r.confidence).toBe(0.92);
  });

  it('extracts music entity for playback requests', async () => {
    const r = await classifyIntentLLM('我想听周杰伦的歌', base, llmResponding(
      '{"category":"command","confidence":0.88,"entities":{"music":"周杰伦的歌"},"sentiment":{"valence":0.6,"urgency":0,"frustration":0}}',
    ));
    expect(r.entities.music).toBe('周杰伦的歌');
  });

  it('extracts musicProfile entity for liked-songs analysis requests', async () => {
    const r = await classifyIntentLLM('分析一下我的音乐画像', base, llmResponding(
      '{"category":"analysis","confidence":0.8,"entities":{"musicProfile":"true"},"sentiment":{"valence":0.3,"urgency":0,"frustration":0}}',
    ));
    expect(r.entities.musicProfile).toBe('true');
  });

  it('extracts background entity for explicit async delegation', async () => {
    const r = await classifyIntentLLM('这个不用等，后台处理', base, llmResponding(
      '{"category":"command","confidence":0.75,"entities":{"background":"true"},"sentiment":{"valence":0,"urgency":0.6,"frustration":0}}',
    ));
    expect(r.entities.background).toBe('true');
  });

  it('passes sentiment through to extractSentiment (无正则情绪猜测)', async () => {
    const r = await classifyIntentLLM('今天有点烦', base, llmResponding(
      '{"category":"conversation","confidence":0.7,"entities":{},"sentiment":{"valence":-0.4,"urgency":0.2,"frustration":0.5}}',
    ));
    const s = extractSentiment('今天有点烦', r.sentiment);
    expect(s.valence).toBe(-0.4);
    expect(s.frustration).toBe(0.5);
  });

  it('falls back to base intent when LLM fails', async () => {
    const r = await classifyIntentLLM('whatever', base, async () => { throw new Error('llm down'); });
    expect(r.category).toBe('unknown');
    expect(r.entities).toEqual({});
  });

  it('falls back to base intent on invalid JSON', async () => {
    const r = await classifyIntentLLM('whatever', base, async () => 'not-json');
    expect(r.category).toBe('unknown');
  });

  it('merges base entities with LLM entities', async () => {
    const r = await classifyIntentLLM('读取文件 a.ts', { ...base, entities: { filePath: 'a.ts' } }, llmResponding(
      '{"category":"file","confidence":0.9,"entities":{"filePath":"a.ts"},"sentiment":{"valence":0,"urgency":0,"frustration":0}}',
    ));
    expect(r.category).toBe('file');
    expect(r.entities.filePath).toBe('a.ts');
  });

  it('classifyIntent rejects empty/whitespace input with unknown (不调 LLM)', async () => {
    let calls = 0;
    const llm = async () => { calls++; return '{"category":"conversation"}'; };
    const r = await classifyIntent('   ', llm);
    expect(r.category).toBe('unknown');
    expect(calls).toBe(0);
  });

  it('caches identical inputs (LRU) — second call does not invoke LLM', async () => {
    let calls = 0;
    const llm = async () => { calls++; return '{"category":"conversation","confidence":0.6,"entities":{},"sentiment":{"valence":0,"urgency":0,"frustration":0}}'; };
    await classifyIntentLLM('你好', base, llm);
    await classifyIntentLLM('你好', base, llm);
    expect(calls).toBe(1);
  });

  it('LLM 分类覆盖 8 大意图类别（与 CLASSIFIER_PROMPT 一致）', async () => {
    const cases: Array<[string, string]> = [
      ['command', '打开 Chrome'],
      ['question', '什么是 TypeScript'],
      ['conversation', '今天心情不错'],
      ['code', '修复这个 bug'],
      ['web', '搜索天气'],
      ['file', '列出桌面文件'],
      ['system', '系统状态'],
      ['analysis', '对比这两个方案'],
    ];
    for (const [cat, text] of cases) {
      const r = await classifyIntentLLM(text, base, llmResponding(
        `{"category":"${cat}","confidence":0.9,"entities":{},"sentiment":{"valence":0,"urgency":0,"frustration":0}}`,
      ));
      expect(r.category).toBe(cat);
    }
  });
});
