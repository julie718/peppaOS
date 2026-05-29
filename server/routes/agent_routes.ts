import { Router, Request, Response, NextFunction } from "express";
import { readDB, writeDB } from "../../db_layer";
import { getOrCreateActiveConversation, getActiveConversation, getMessages, addMessage } from "../conversation/manager";
import { getKey } from "../config/keys";
import { makeLLMCall, NormalizedMessage } from "../llm/providers";
import { requireAuth } from "../middleware/auth";

const asyncHandler = (fn: (req: Request, res: Response, next?: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

export function mountAgentRoutes(
  router: Router,
  _jwtSecret: string,
  llmGetters: { getDeepSeek: () => any; getGemini: () => any; getOpenAI?: () => any; getAnthropic?: () => any; getQwen?: () => any; },
) {
  router.post("/agents/distill", requireAuth, asyncHandler(async (req, res) => {
    const uid = req.user!.uid;
    const { chatLog, format, relationshipType, name: targetName } = req.body || {};
    if (!chatLog || !format) return res.status(400).json({ error: "chatLog and format are required" });
    if (!['wechat', 'qq', 'plain'].includes(format)) return res.status(400).json({ error: "format must be: wechat, qq, or plain" });
    try {
      const { distillPersona } = await import('../agents/distiller');
      const result = await distillPersona(
        { chatLog, format, targetName, relationshipType, userId: uid },
        { getDeepSeek: llmGetters.getDeepSeek, getGemini: llmGetters.getGemini, getOpenAI: llmGetters.getOpenAI, getAnthropic: llmGetters.getAnthropic, getQwen: llmGetters.getQwen },
      );
      res.json({ personalityConfig: result.personalityConfig, seedMemories: result.seedMemories, evidenceMap: result.evidenceMap, relationshipType: result.relationshipType, narrative: result.narrative, inferredName: result.inferredName, summary: { messageCount: chatLog.split('\n').filter((l: string) => l.trim()).length, memoryCount: result.seedMemories.length, cognitiveStyle: result.personalityConfig.personalityVector?.cognitiveStyle, socialStyle: result.personalityConfig.personalityVector?.socialStyle, tone: result.personalityConfig.expressionStyle.tone, topPhrases: result.personalityConfig.expressionStyle.vocabularyHints?.slice(0, 5) } });
    } catch (err: any) { console.error('[Distill] Failed:', err.message); res.status(500).json({ error: err.message || 'Distillation failed' }); }
  }));

  router.get("/agents/sanctuaries", requireAuth, (req, res) => {
    try {
      const db = readDB();
      const sanctuaries = (db.agents || []).filter((a: any) => a.ownerUid === req.user!.uid && a.territory === 'sanctuary').map((a: any) => ({ id: a.id, name: a.name, relationshipType: a.relationshipType || 'close_friend', isFrozen: a.isFrozen ?? true, memoryCount: (db.memories || []).filter((m: any) => m.agentId === a.id).length, createdAt: a.createdAt, lastActiveAt: a.lastActiveAt }));
      res.json({ sanctuaries });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get("/agents/:id/history", requireAuth, (req, res) => {
    try {
      const { id } = req.params; const db = readDB();
      const isDefault = ['lumi', 'lumi_default', 'scholar_default', 'founder_default', 'incubated'].includes(id);
      if (!isDefault && !db.agents.find((a: any) => a.id === id && a.ownerUid === req.user!.uid)) return res.status(404).json({ error: "Agent not found" });
      const conv = getActiveConversation(req.user!.uid, id);
      const msgs = conv ? getMessages(conv.id, 100) : [];
      res.json(msgs.map((m: any) => ({ role: m.role, content: m.content || m.message || '' })));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post("/agents/:id/history", requireAuth, (req, res) => {
    try {
      const { id } = req.params; const { messages } = req.body;
      const db = readDB(); const isDefault = ['lumi', 'lumi_default', 'scholar_default', 'founder_default', 'incubated'].includes(id);
      if (!isDefault && !db.agents.find((a: any) => a.id === id && a.ownerUid === req.user!.uid)) return res.status(404).json({ error: "Agent not found" });
      const conv = getOrCreateActiveConversation(req.user!.uid, id);
      if (Array.isArray(messages)) for (const msg of messages) addMessage({ userId: req.user!.uid, agentId: id, conversationId: conv.id, role: msg.role || 'user', content: msg.content || '' });
      res.json({ success: true, conversationId: conv.id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get("/agents", requireAuth, (req, res) => {
    try { res.json(readDB().agents.filter((a: any) => a.ownerUid === req.user!.uid && !a.id.startsWith('ephemeral_'))); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post("/agents", requireAuth, (req, res) => {
    try {
      const { name, category, data, personalityId, modelPreference, memoryScope, autonomyLevel, territory, distilledFrom, evidenceMap, relationshipType, isFrozen, seedMemoryIds, executionMode } = req.body;
      const db = readDB(); const isSanctuary = territory === 'sanctuary';
      const agent: any = { id: Math.random().toString(36).substring(2, 15), ownerUid: req.user!.uid, name, category: category || (relationshipType || 'friend'), data: data || '{}', status: "active", personalityId: personalityId || 'lumi', modelPreference: modelPreference || '', memoryScope: isSanctuary ? 'private' : (memoryScope || 'shared'), autonomyLevel: isSanctuary ? 'reactive' : (autonomyLevel || 'reactive'), runtimeConfig: '{}', territory: territory || 'open', distilledFrom: distilledFrom || '', evidenceMap: evidenceMap || [], relationshipType: relationshipType || '', isFrozen: isFrozen ?? isSanctuary, seedMemoryIds: seedMemoryIds || [], executionMode: executionMode || '', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), skillTags: [], knowledgeDomains: [], allowCrossPollination: !isSanctuary };
      db.agents.push(agent); writeDB(db); res.json(agent);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/agents/:id", requireAuth, (req, res) => {
    try {
      const { id } = req.params; const db = readDB();
      const idx = db.agents.findIndex((a: any) => a.id === id && a.ownerUid === req.user!.uid);
      if (idx === -1) return res.status(404).json({ error: "Agent not found or unauthorized" });
      db.agents.splice(idx, 1); writeDB(db); res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post("/audio/transcribe", asyncHandler(async (req, res) => {
    const { audio, fileName } = req.body || {};
    if (!audio) return res.status(400).json({ error: "Audio data is required" });
    try {
      const dgKey = process.env.DEEPGRAM_API_KEY || getKey('DEEPGRAM_API_KEY');
      if (dgKey) { const buffer = Buffer.from(audio, 'base64'); const dgRes = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=zh&punctuate=true', { method: 'POST', headers: { 'Authorization': `Token ${dgKey}`, 'Content-Type': fileName?.endsWith('.wav') ? 'audio/wav' : fileName?.endsWith('.ogg') ? 'audio/ogg' : fileName?.endsWith('.m4a') ? 'audio/mp4' : 'audio/mp3' }, body: buffer }); if (dgRes.ok) { const data = await dgRes.json() as any; return res.json({ text: data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '' }); } }
      const qwenKey = process.env.DASHSCOPE_API_KEY || getKey('DASHSCOPE_API_KEY');
      if (qwenKey) { const buffer = Buffer.from(audio, 'base64'); const form = new FormData(); form.append('model', 'sensevoice-v1'); form.append('file', new Blob([buffer]), fileName || 'audio.mp3'); const qwRes = await fetch('https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription', { method: 'POST', headers: { 'Authorization': `Bearer ${qwenKey}` }, body: form }); if (qwRes.ok) { const data = await qwRes.json() as any; return res.json({ text: data?.output?.sentence?.text || '' }); } }
      res.json({ text: '', note: 'No STT provider configured' });
    } catch (err: any) { res.json({ text: '', error: err.message }); }
  }));

  router.post("/pets/generate", asyncHandler(async (req, res) => {
    const { prompt, mode } = req.body || {};
    if (!prompt?.trim()) return res.status(400).json({ error: "Prompt is required" });
    const lower = prompt.toLowerCase();
    const colorMap: Record<string, any> = { white: '#f0f0f0', black: '#3a3a3a', red: '#e85545', blue: '#5599dd', green: '#5ddb5d', purple: '#9966cc', pink: '#f0a0b0', orange: '#f4a460', yellow: '#f5d442', grey: '#888888' };
    if (mode === 'ai_enhanced') {
      try {
        const llmPrompt = `You are a pixel art character designer. Given: "${prompt}". Output ONLY valid JSON: { "petName": "...", "color": "white|black|red|blue|green|purple|pink|orange|yellow|grey", "hasWings": true/false, "hasHorns": true/false, "isSmall": true/false, "isRound": true/false }`;
        const result = await makeLLMCall([{ role: 'user', content: llmPrompt }], [], { provider: 'qwen', model: 'qwen-plus', maxTokens: 500 }, llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen);
        let aiDesign: any = {}; try { aiDesign = JSON.parse((result.text || '').replace(/```json|```/g, '').trim()); } catch { aiDesign = {}; }
        const color = aiDesign.color && colorMap[aiDesign.color] ? aiDesign.color : 'orange';
        return res.json({ generated: true, prompt, petId: `ai-${Date.now()}`, petName: aiDesign.petName || prompt.slice(0, 30), tags: { color, hasWings: !!aiDesign.hasWings, hasHorns: !!aiDesign.hasHorns, isSmall: !!aiDesign.isSmall, isRound: !!aiDesign.isRound }, aiEnhanced: true });
      } catch (err: any) { console.error('[Pet Gen] AI-enhanced failed:', err.message); }
    }
    const hasWings = /wing|fly|bird|dragon/i.test(lower), hasHorns = /horn|dragon/i.test(lower), isSmall = /small|tiny|mini/i.test(lower), isRound = /round|blob|ball|slime/i.test(lower);
    res.json({ generated: true, prompt, petId: `custom-${Date.now()}`, petName: prompt.slice(0, 30), tags: { color: Object.keys(colorMap).find(c => lower.includes(c)) || 'orange', hasWings, hasHorns, isSmall, isRound } });
  }));
}
