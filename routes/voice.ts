import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { synthesizeSpeech, cloneVoice, designVoice, listVoices, getActiveProvider } from '../server/tts/adapter';
import { TTSProvider } from '../server/tts/types';
import { readDB, writeDB } from '../db_layer';
import { getKey } from '../server/config/keys';
import { logger } from '../logger';
import { recordLatency } from '../server/monitor/latency_store';
import { getDataPath } from '../server/config/data_path';
import { requireAuth } from '../server/middleware/auth';

const router = Router();

const samplesDir = getDataPath('voice_samples');
fs.mkdirSync(samplesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const userId = (_req as any).user?.uid || (_req as any).userId || 'anonymous';
    const userDir = path.join(samplesDir, userId);
    fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_\-. ]/g, '');
    cb(null, `${timestamp}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (_req, file, cb) => {
    const base = (file.mimetype || '').split(';')[0];
    const allowed = ['audio/webm', 'audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/wave', 'audio/ogg', 'audio/m4a', 'audio/x-wav', 'audio/x-pn-wav'];
    if (allowed.includes(base)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported audio format: ${file.mimetype}`));
    }
  },
});

function getUserId(req: Request): string {
  return (req as any).user?.uid || (req as any).userId || 'anonymous';
}

// POST /api/voice/samples — Upload voice sample(s) for cloning
router.post('/voice/samples', requireAuth, upload.array('samples', 5), (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    console.log('[Voice Upload] Received files:', files?.length, 'userId:', getUserId(req));
    if (!files || files.length === 0) {
      console.log('[Voice Upload] No files — req.file:', req.file, 'req.files:', req.files, 'req.body:', req.body);
      return res.status(400).json({ error: 'No audio files provided' });
    }
    files.forEach(f => console.log('[Voice Upload] File:', f.filename, f.size, f.mimetype, f.path));

    const urls = files.map(f => `/api/voice/samples/${getUserId(req)}/${f.filename}`);
    console.log('[Voice Upload] Returning URLs:', urls);
    res.json({ urls, filenames: files.map(f => f.filename), count: files.length });
  } catch (err: any) {
    console.log('[Voice Upload] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/voice/samples/:userId/:filename — Serve uploaded samples
router.get('/voice/samples/:userId/:filename', requireAuth, (req: Request, res: Response) => {
  if (req.params.userId !== req.user!.uid) {
    return res.status(403).json({ error: 'Sample not found' });
  }
  const filePath = path.join(samplesDir, req.params.userId, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Sample not found' });
  }
  res.sendFile(filePath);
});

// POST /api/voice/clone — Trigger voice cloning
router.post('/voice/clone', requireAuth, async (req: Request, res: Response) => {
  try {
    const { sampleUrls, name, provider } = req.body;

    if (!sampleUrls || !Array.isArray(sampleUrls) || sampleUrls.length === 0) {
      return res.status(400).json({ error: 'At least one sample URL is required' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Voice name is required' });
    }

    const activeProvider = (provider || 'cosyvoice') as TTSProvider;
    if (activeProvider !== 'cosyvoice') {
      return res.status(400).json({
        error: 'Voice cloning currently supports CosyVoice only. Choose CosyVoice in the cloning flow or add a provider adapter.',
        activeProvider,
        supportedProviders: ['cosyvoice'],
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const absoluteUrls = sampleUrls.map((url: string) =>
      url.startsWith('http') ? url : `${baseUrl}${url}`
    );
    console.log('[Voice Clone] sampleUrls:', sampleUrls, 'absoluteUrls:', absoluteUrls, 'name:', name, 'provider:', activeProvider);

    const voiceId = await cloneVoice({ sampleUrls: absoluteUrls, name }, activeProvider);
    console.log('[Voice Clone] Got voiceId:', voiceId);

    // Store voice reference in user data
    const db = readDB();
    const userId = getUserId(req);
    console.log('[Voice Clone] Writing to DB for userId:', userId);
    if (!db.voiceProfiles) db.voiceProfiles = {};
    if (!db.voiceProfiles[userId]) db.voiceProfiles[userId] = [];
    db.voiceProfiles[userId].push({
      voiceId,
      name,
      provider: activeProvider,
      category: 'cloned',
      createdAt: new Date().toISOString(),
    });
    writeDB(db);
    console.log('[Voice Clone] DB written, responding with voiceId:', voiceId);

    res.json({ voiceId, name, provider: activeProvider, category: 'cloned' });
  } catch (err: any) {
    logger.error('[Voice Clone Error]', err);
    res.status(500).json({ error: err.message || 'Voice cloning service unavailable' });
  }
});

// POST /api/voice/design — Design a new voice from text description
router.post('/voice/design', requireAuth, async (req: Request, res: Response) => {
  try {
    const { prompt, name } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'Voice prompt is required (at least 10 characters)' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Voice name is required' });
    }
    const activeProvider = ((req.body?.provider as TTSProvider | undefined) || 'cosyvoice') as TTSProvider;
    if (activeProvider !== 'cosyvoice') {
      return res.status(400).json({ error: 'Voice design currently supports CosyVoice only. Use CosyVoice (DashScope).' });
    }

    const voiceId = await designVoice(prompt.trim(), name, activeProvider);

    const db = readDB();
    const userId = getUserId(req);
    if (!db.voiceProfiles) db.voiceProfiles = {};
    if (!db.voiceProfiles[userId]) db.voiceProfiles[userId] = [];
    db.voiceProfiles[userId].push({
      voiceId,
      name,
      provider: activeProvider,
      category: 'cloned',
      prompt: prompt.trim(),
      createdAt: new Date().toISOString(),
    });
    writeDB(db);

    res.json({ voiceId, name, provider: activeProvider, category: 'cloned' });
  } catch (err: any) {
    logger.error('[Voice Design Error]', err);
    res.status(500).json({ error: err.message || 'Voice design service unavailable' });
  }
});

// GET /api/voice/voices — List user's cloned voices + ALL provider premade voices
router.get('/voice/voices', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const db = readDB();
    const userVoices = (db.voiceProfiles?.[userId] || []).map((voice: any) => ({
      ...voice,
      category: 'cloned' as const,
    }));

    // Fetch premade voices from ALL available providers, not just the active one
    let premadeVoices: any[] = [];
    const providers: TTSProvider[] = [];

    // Check which providers are available (by API key / server presence)
    if (true) {
      // cosyvoice always available if dashscope key is set
      const dk = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY');
      if (dk) providers.push('cosyvoice');
    }
    {
      // Ark (Doubao) TTS needs separate Speech AppID + Token (not ARK_API_KEY for LLM)
      const { hasDoubaoSpeech } = await import('../server/tts/providers/ark');
      if (hasDoubaoSpeech()) providers.push('ark');
    }
    if (process.env.GPTSOVITS_API_URL || process.env.GPTSOVITS_ENABLED === 'true') {
      providers.push('gptsovits');
    }
    // If nothing configured, fall back to active provider
    if (providers.length === 0) {
      const active = getActiveProvider();
      if (active) providers.push(active);
    }

    for (const provider of providers) {
      try {
        const voices = await listVoices(provider);
        // Tag each voice with its provider so the frontend can show it
        premadeVoices.push(...voices.map(v => ({ ...v, category: v.category || 'premade', provider })));
      } catch {
        // Provider not available — skip
      }
    }

    res.json({
      cloned: userVoices,
      premade: premadeVoices,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/voice/:voiceId — Delete a cloned voice
router.delete('/voice/:voiceId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const db = readDB();
    const userVoices = db.voiceProfiles?.[userId] || [];
    const voiceIdx = userVoices.findIndex((v: any) => v.voiceId === req.params.voiceId);

    if (voiceIdx === -1) {
      return res.status(404).json({ error: 'Voice not found' });
    }

    const [removed] = userVoices.splice(voiceIdx, 1);
    db.voiceProfiles[userId] = userVoices;
    writeDB(db);

    res.json({ deleted: removed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/synthesize — Synthesize speech (for TTS without full voice call)
router.post('/voice/synthesize', requireAuth, async (req: Request, res: Response) => {
  try {
    const { text, voiceId, provider } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required' });
    }

    const activeProvider = provider || getActiveProvider();
    if (!activeProvider) {
      return res.status(400).json({ error: 'No TTS provider configured' });
    }

    const start = Date.now();
    const result = await synthesizeSpeech(text, {
      provider: activeProvider,
      voiceId: voiceId || 'default',
    });
    recordLatency('tts', Date.now() - start);

    res.set('Content-Type', `audio/${result.format}`);
    res.set('X-Audio-Format', result.format);
    res.send(result.audioBuffer);
  } catch (err: any) {
    logger.error('[Voice Synthesize Error]', err);
    res.status(500).json({ error: 'Speech synthesis unavailable' });
  }
});

// Voice provider preferences
import { getVoicePreference, setVoicePreference } from '../server/config/voice_preference';
import { getActiveProvider as getActiveTTSProvider } from '../server/tts/adapter';
import { getActiveSTTProvider } from '../server/stt/adapter';

router.get('/voice/active-provider', (_req, res) => {
  try {
    const pref = getVoicePreference();
    res.json({
      pref,
      active: { stt: getActiveSTTProvider(), tts: getActiveTTSProvider?.() || 'cosyvoice' },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/voice/provider', (req, res) => {
  try {
    const { stt, tts } = req.body;
    const merged = setVoicePreference({ stt: stt || undefined, tts: tts || undefined } as any);
    res.json(merged);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
