import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tempRoot = '';
let previousDataDir: string | undefined;
const clearedEnvKeys = ['DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'DOUBAO_SPEECH_KEY'] as const;
let previousKeys: Partial<Record<(typeof clearedEnvKeys)[number], string | undefined>> = {};

async function loadModule() {
  return import('../server/stt/file_transcription');
}

describe('audio file transcription helper', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peppa_audio_test_'));
    previousDataDir = process.env.LUMI_DATA_DIR;
    process.env.LUMI_DATA_DIR = tempRoot;
    previousKeys = {};
    for (const key of clearedEnvKeys) {
      previousKeys[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LUMI_DATA_DIR;
    else process.env.LUMI_DATA_DIR = previousDataDir;
    for (const key of clearedEnvKeys) {
      const value = previousKeys[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  });

  it('detects common audio mime types', async () => {
    const mod = await loadModule();
    expect(mod.getAudioMimeType('meeting.mp3')).toBe('audio/mpeg');
    expect(mod.getAudioMimeType('voice.wav')).toBe('audio/wav');
    expect(mod.getAudioMimeType('memo.m4a')).toBe('audio/mp4');
    expect(mod.isSupportedAudioFileName('clip.flac')).toBe(true);
    expect(mod.isSupportedAudioFileName('notes.txt')).toBe(false);
  });

  it('reports a retryable provider configuration error without network calls', async () => {
    const mod = await loadModule();
    await expect(mod.transcribeAudioFile(Buffer.from('not-a-real-audio'), {
      fileName: 'meeting.mp3',
      preferredProvider: 'auto',
      allowLocal: false,
      providerAvailability: {
        qwen: false,
        deepgram: false,
        whisper: false,
        ark: false,
        'local-whisper': false,
      },
    })).rejects.toMatchObject({ code: 'NO_AUDIO_TRANSCRIPTION_PROVIDER' });
  });

  it('transcribes with the DashScope SenseVoice file endpoint through injected fetch', async () => {
    process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
    const mod = await loadModule();
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer dashscope-test-key');
      return new Response(JSON.stringify({ output: { sentence: { text: '会议记录已经整理好' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await mod.transcribeAudioFile(Buffer.from('fake-audio'), {
      fileName: 'meeting.mp3',
      preferredProvider: 'qwen',
      allowLocal: false,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.text).toBe('会议记录已经整理好');
    expect(result.provider).toBe('qwen');
    expect(result.model).toBe('sensevoice-v1');
    expect(result.mimeType).toBe('audio/mpeg');
  });
});
