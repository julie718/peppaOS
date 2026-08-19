import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { mountSystemRoutes } from '../server/routes/system_routes';

let url: string;
let cleanup: () => void;

describe('Settings & Keys API', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountSystemRoutes(app.apiRouter, JWT_SECRET, { emit: () => {} });
  });

  afterAll(() => cleanup?.());

  it('GET /settings/keys returns masked key status', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
    expect(body).toHaveProperty('DASHSCOPE_API_KEY');
    expect(body).toHaveProperty('DEEPSEEK_API_KEY');
  });

  it('POST /settings/keys rejects plaintext save when OXOG_ENV_KEY is missing', async () => {
    // P1-5 摒弃明文密钥配置：无 OXOG_ENV_KEY 时保存必须被拒绝（500 + 提示），
    // keys.json 不得以明文落盘。
    delete process.env.OXOG_ENV_KEY;
    const res = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { DEEPSEEK_API_KEY: 'sk-plaintext' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('OXOG_ENV_KEY');
  });

  it('POST /settings/keys saves and reports saved (with OXOG_ENV_KEY)', async () => {
    // P1-5：注入 64-hex OXOG_ENV_KEY（测试环境仅在内存中设置，不写 .env）
    process.env.OXOG_ENV_KEY = 'a'.repeat(64);
    try {
      const res = await fetch(`${url}/api/settings/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: { DEEPSEEK_API_KEY: 'sk-test' } }),
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.saved).toContain('DEEPSEEK_API_KEY');

      // Read back
      const read = await fetch(`${url}/api/settings/keys`, {
        signal: AbortSignal.timeout(5000),
      });
      const readBody = await read.json();
      expect(readBody.DEEPSEEK_API_KEY).toBe(true);
    } finally {
      delete process.env.OXOG_ENV_KEY;
    }
  });

  it('POST /settings/keys rejects empty payload', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });
});
