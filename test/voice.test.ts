import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, JWT_SECRET, COOKIE_OPTS } from './helpers';
import voiceRoutes from '../routes/voice';
import { mountAuthRoutes } from '../server/routes/auth';
import { resolveVoiceTtsProvider } from '../server/tts/adapter';
import { getActiveSTTProvider } from '../server/stt/adapter';

let url: string;
let cleanup: () => void;
let token: string;

describe('Voice API', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);
    app.apiRouter.use('/', voiceRoutes);

    await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'voice_tester', password: 'pass123', phone: '13800004444' }),
    });
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'voice_tester', password: 'pass123' }),
    });
    token = (await login.json()).token;
  });

  afterAll(() => cleanup?.());

  function headers() {
    return {
      'Content-Type': 'application/json',
      'Cookie': `token=${token}`,
    };
  }

  it('requires auth for voice list', async () => {
    const res = await fetch(`${url}/api/voice/voices`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(401);
  });

  it('returns voice list for authenticated users', async () => {
    const res = await fetch(`${url}/api/voice/voices`, {
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('cloned');
    expect(body).toHaveProperty('premade');
    expect(Array.isArray(body.cloned)).toBe(true);
    expect(Array.isArray(body.premade)).toBe(true);
  });

  it('returns active provider info', async () => {
    const res = await fetch(`${url}/api/voice/active-provider`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Response is { pref: {...}, active: { stt: string, tts: string } }
    expect(body).toHaveProperty('pref');
    expect(body).toHaveProperty('active');
    expect(body.active).toHaveProperty('stt');
    expect(body.active).toHaveProperty('tts');
  });

  it('rejects synthesize without body', async () => {
    const res = await fetch(`${url}/api/voice/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });

  it('resolves the voice provider from a selected voice when one is provided', async () => {
    const provider = resolveVoiceTtsProvider({ provider: 'cosyvoice', voiceId: 'longxiaochun_v3' });
    expect(provider).toBe('cosyvoice');
  });

  it('prefers Deepgram over Qwen for auto STT when both are available', async () => {
    const previousQwen = process.env.DASHSCOPE_API_KEY;
    const previousDeepgram = process.env.DEEPGRAM_API_KEY;
    process.env.DASHSCOPE_API_KEY = 'qwen-test-key';
    process.env.DEEPGRAM_API_KEY = 'deepgram-test-key';
    try {
      expect(getActiveSTTProvider()).toBe('deepgram');
    } finally {
      if (previousQwen === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = previousQwen;
      if (previousDeepgram === undefined) delete process.env.DEEPGRAM_API_KEY;
      else process.env.DEEPGRAM_API_KEY = previousDeepgram;
    }
  });

  it('verifies enrolled voiceprints on the server', async () => {
    const makeFrames = (invert = false) => Array.from({ length: 24 }, (_, frameIndex) => {
      const sign = invert ? -1 : 1;
      return Array.from({ length: 13 }, (_, coeffIndex) => {
        if (coeffIndex === 0) return 0.2 + frameIndex * 0.001;
        return sign * (Math.sin(coeffIndex * 0.7) + Math.cos(coeffIndex * 0.31)) + frameIndex * 0.002;
      });
    });

    const enrolledFrames = makeFrames(false);
    const enroll = await fetch(`${url}/api/auth/biometric/voiceprint/enroll`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ label: 'Owner voice', mfccFeatures: enrolledFrames, sampleCount: enrolledFrames.length }),
      signal: AbortSignal.timeout(5000),
    });
    expect(enroll.status).toBe(200);

    const pass = await fetch(`${url}/api/auth/biometric/voiceprint/verify`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ mfccFeatures: makeFrames(false) }),
      signal: AbortSignal.timeout(5000),
    });
    const passBody = await pass.json();
    expect(pass.status).toBe(200);
    expect(passBody.isOwnerSpeaking).toBe(true);
    expect(passBody.confidence).toBeGreaterThanOrEqual(0.68);

    const reject = await fetch(`${url}/api/auth/biometric/voiceprint/verify`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ mfccFeatures: makeFrames(true) }),
      signal: AbortSignal.timeout(5000),
    });
    const rejectBody = await reject.json();
    expect(reject.status).toBe(200);
    expect(rejectBody.isOwnerSpeaking).toBe(false);
  });

  it('accepts PCM voiceprint payloads with MFCC fallback when mature provider is disabled', async () => {
    const previousProvider = process.env.LUMI_VOICEPRINT_PROVIDER;
    process.env.LUMI_VOICEPRINT_PROVIDER = 'mfcc';
    try {
      const makeFrames = () => Array.from({ length: 24 }, (_, frameIndex) => {
        return Array.from({ length: 13 }, (_, coeffIndex) => {
          if (coeffIndex === 0) return 0.15 + frameIndex * 0.001;
          return Math.sin(coeffIndex * 0.37) + Math.cos(coeffIndex * 0.19) + frameIndex * 0.0015;
        });
      });
      const pcm16Base64 = Buffer.alloc(16000 * 2).toString('base64');
      const frames = makeFrames();

      const enroll = await fetch(`${url}/api/auth/biometric/voiceprint/enroll`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({
          label: 'Fallback voice',
          mfccFeatures: frames,
          audioPcm16Base64: pcm16Base64,
          sampleRate: 16000,
          sampleCount: frames.length,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const enrollBody = await enroll.json();
      expect(enroll.status).toBe(200);
      expect(enrollBody.voiceprint.embeddingReady).toBe(false);
      expect(enrollBody.voiceprintProvider.source).toBe('local');

      const verify = await fetch(`${url}/api/auth/biometric/voiceprint/verify`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          mfccFeatures: frames,
          audioPcm16Base64: pcm16Base64,
          sampleRate: 16000,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const verifyBody = await verify.json();
      expect(verify.status).toBe(200);
      expect(verifyBody.isOwnerSpeaking).toBe(true);
      expect(verifyBody.source).toBe('local');
      expect(verifyBody.fallbackReason).toBe('provider_disabled');
    } finally {
      if (previousProvider === undefined) delete process.env.LUMI_VOICEPRINT_PROVIDER;
      else process.env.LUMI_VOICEPRINT_PROVIDER = previousProvider;
    }
  });
});
