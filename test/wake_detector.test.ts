import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// ── Wake detector factory — pure logic tests ──

// Node.js doesn't have WebSocket built-in; mock it so factory doesn't throw
const originalWebSocket = (globalThis as any).WebSocket;
(globalThis as any).WebSocket = class MockWebSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(_data: any) {}
  close() {}
};

describe('Wake Detector Factory', () => {
  const mockGetVoicePref = vi.fn();
  const mockGetKey = vi.fn();

  afterAll(() => {
    (globalThis as any).WebSocket = originalWebSocket;
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Reset env
    delete process.env.DOUBAO_SPEECH_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.QWEN_API_KEY;
  });

  it('throws when no keys are configured', async () => {
    // Simulate no keys at all
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'auto', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({
      getKey: () => undefined,
    }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    expect(() => createWakeDetector()).toThrow('Doubao Speech');
  });

  it('selects Qwen when STT preference is qwen and key exists', async () => {
    process.env.DASHSCOPE_API_KEY = 'sk-test123';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'qwen', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({
      getKey: () => undefined,
    }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    // Should not throw — Qwen key is in env
    const session = createWakeDetector();
    expect(session).toBeDefined();
    expect(session.sendAudio).toBeDefined();
    expect(session.stop).toBeDefined();
    expect(session.onWake).toBeDefined();
    expect(session.onError).toBeDefined();
    session.stop();
  });

  it('selects Ark when STT preference is ark and Doubao key has colon', async () => {
    process.env.DOUBAO_SPEECH_KEY = '12345:token-abc';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'ark', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({
      getKey: () => undefined,
    }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    const session = createWakeDetector();
    expect(session).toBeDefined();
    expect(session.sendAudio).toBeDefined();
    session.stop();
  });

  it('falls back to available provider when preference cannot be satisfied', async () => {
    // User prefers ark but only Qwen key exists
    process.env.DASHSCOPE_API_KEY = 'sk-test123';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'ark', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({
      getKey: () => undefined,
    }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    // Should fall back to Qwen since no valid Doubao key
    const session = createWakeDetector();
    expect(session).toBeDefined();
    session.stop();
  });

  it('isWakeWord matches Chinese and English variants', async () => {
    const { isWakeWord } = await import('../server/stt/wake_detector');

    expect(isWakeWord('jarvis')).toBe('Jarvis'); // lowercased input matches 'Jarvis' first in WAKE_WORDS
    expect(isWakeWord('Jarvis')).toBe('Jarvis');
    expect(isWakeWord('贾维斯')).toBe('贾维斯');
    // 'peppa' before more specific matches in WAKE_WORDS array
    expect(isWakeWord('peppa')).toBe('peppa');
    expect(isWakeWord('Peppa')).toBe('peppa');
    expect(isWakeWord('Hey Peppa')).toBe('peppa'); // substring match: 'peppa' found before 'Hey Peppa'
    expect(isWakeWord('豆包')).toBe('豆包');
    expect(isWakeWord('豆瓣')).toBe('豆瓣');
    expect(isWakeWord('嘿 豆包')).toBe('豆包'); // '豆包' substring match comes before '嘿 豆包'

    // Non-wake words
    expect(isWakeWord('hello world')).toBeNull();
    expect(isWakeWord('今天天气不错')).toBeNull();
    expect(isWakeWord('')).toBeNull();
  });
});
