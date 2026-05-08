import { Router } from "express";
import jwt from "jsonwebtoken";
import { readDB, writeDB } from "../../db_layer";
import {
  queryMemories, addMemory, removeMemory,
  addReminder, fireReminder,
  runBehavioralAnalysis, broadcastMemoryChange,
  getDueReminders, getUnconsolidatedEpisodic,
} from "../memory";
import { consolidateEpisodic, selfReflect, ConsolidationContext } from "../memory/consolidator";

export function mountMemoryRoutes(
  router: Router,
  jwtSecret: string,
  llmGetters: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI?: () => any;
    getAnthropic?: () => any;
    getQwen?: () => any;
  },
) {
  // Memory CRUD
  router.get("/memories", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const type = req.query.type as string | undefined;
      const search = req.query.search as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;

      const memories = queryMemories({
        userId: decoded.uid,
        type: type as any,
        query: search,
        limit,
        minConfidence: 0,
      });
      res.json(memories);
    } catch (e) {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  router.post("/memories", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const { type, content, keywords, confidence } = req.body;

      if (!type || !content) {
        return res.status(400).json({ error: "type and content are required" });
      }

      const memory = addMemory({
        userId: decoded.uid.replace(/[^a-zA-Z0-9_-]/g, '_'),
        type,
        content,
        keywords: keywords || [],
        confidence: confidence || 0.5,
        sourceInteractionId: 'manual',
      });
      broadcastMemoryChange(decoded.uid, 'added', memory.id);
      res.json(memory);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/memories/:id", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const { id } = req.params;
      const { content, keywords, confidence, type } = req.body;

      const all = readDB().memories || [];
      const idx = all.findIndex((m: any) => m.id === id && m.userId === decoded.uid);
      if (idx === -1) return res.status(404).json({ error: "Memory not found" });

      const existing = all[idx];
      if (content !== undefined) existing.content = content;
      if (keywords !== undefined) existing.keywords = keywords;
      if (confidence !== undefined) existing.confidence = confidence;
      if (type !== undefined) existing.type = type;
      existing.updatedAt = new Date().toISOString();

      const db = readDB();
      db.memories = all;
      writeDB(db);
      broadcastMemoryChange(decoded.uid, 'updated', existing.id);
      res.json(existing);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete("/memories/:id", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const { id } = req.params;

      const all = readDB().memories || [];
      const idx = all.findIndex((m: any) => m.id === id && m.userId === decoded.uid);
      if (idx === -1) return res.status(404).json({ error: "Memory not found" });

      const memoryId = all[idx].id;
      all.splice(idx, 1);
      const db = readDB();
      db.memories = all;
      writeDB(db);
      broadcastMemoryChange(decoded.uid, 'deleted', memoryId);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Behavioral analysis
  router.post("/memory/analyze-behavior", (req, res) => {
    try {
      const token = req.cookies.token;
      let uid = 'anonymous';
      if (token) {
        try { const decoded: any = jwt.verify(token, jwtSecret); uid = decoded.uid; } catch {}
      }
      const count = runBehavioralAnalysis(uid);
      res.json({ success: true, patternsFound: count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reminders CRUD
  router.get("/reminders", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const db = readDB();
      const reminders = (db.reminders || []).filter((r: any) => r.userId === decoded.uid);
      res.json(reminders);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/reminders", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const { content, dueAt } = req.body || {};
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content is required" });
      }
      const reminder = addReminder({
        userId: decoded.uid,
        content: content.trim(),
        dueAt: dueAt || null,
        sourceInteractionId: "manual",
      });
      res.json(reminder);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/reminders/:id", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const db = readDB();
      const reminders = db.reminders || [];
      const reminder = reminders.find((r: any) => r.id === req.params.id && r.userId === decoded.uid);
      if (!reminder) return res.status(404).json({ error: "Reminder not found" });

      const { content, dueAt, status } = req.body || {};
      if (content !== undefined) reminder.content = String(content).trim();
      if (dueAt !== undefined) reminder.dueAt = dueAt || null;
      if (status === "fired" && reminder.status !== "fired") {
        fireReminder(reminder.id);
        return res.json({ ...reminder, status: "fired", firedAt: new Date().toISOString() });
      }
      if (status === "pending") {
        reminder.status = "pending";
        reminder.firedAt = null;
      }
      db.reminders = reminders;
      writeDB(db);
      res.json(reminder);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete("/reminders/:id", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const db = readDB();
      const reminders = db.reminders || [];
      const idx = reminders.findIndex((r: any) => r.id === req.params.id && r.userId === decoded.uid);
      if (idx === -1) return res.status(404).json({ error: "Reminder not found" });
      reminders.splice(idx, 1);
      db.reminders = reminders;
      writeDB(db);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Memory consolidation
  router.post("/memory/consolidate", async (req, res) => {
    try {
      const userId = (req as any).user?.uid || 'anonymous';
      const ctx: ConsolidationContext = {
        userId,
        provider: (req.body.provider as any) || 'deepseek',
        model: (req.body.model as any) || 'deepseek-chat',
      };
      const minCount = Number(req.body.minCount) || 10;
      const result = await consolidateEpisodic(
        ctx, minCount,
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      );
      if (result) {
        broadcastMemoryChange(userId, 'updated', result.id);
        res.json({ success: true, memory: result });
      } else {
        const unconsolidated = getUnconsolidatedEpisodic(userId);
        res.json({ success: false, reason: 'Not enough unconsolidated episodic memories', unconsolidatedCount: unconsolidated.length, threshold: minCount });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Self-reflection
  router.post("/memory/self-reflect", async (req, res) => {
    try {
      const userId = (req as any).user?.uid || 'anonymous';
      const ctx: ConsolidationContext = {
        userId,
        provider: (req.body.provider as any) || 'deepseek',
        model: (req.body.model as any) || 'deepseek-chat',
      };
      const result = await selfReflect(
        ctx,
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      );
      if (result) {
        broadcastMemoryChange(userId, 'updated', result.id);
        res.json({ success: true, memory: result });
      } else {
        res.json({ success: false, reason: 'No growth memories to reflect on' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Growth timeline
  router.get("/memory/growth", (req, res) => {
    const userId = (req as any).user?.uid || 'anonymous';
    const growth = queryMemories({ userId, tier: 'growth', limit: Number(req.query.limit) || 50, minConfidence: 0.4 });
    const core = queryMemories({ userId, tier: 'core_identity', limit: 10 });
    res.json({ growth, coreIdentity: core });
  });

  // Memory tiers
  router.get("/memory/tiers", (req, res) => {
    const userId = (req as any).user?.uid || 'anonymous';
    const tiers: Record<string, any[]> = {};
    for (const tier of ['core_identity', 'growth', 'internalized', 'episodic']) {
      tiers[tier] = queryMemories({ userId, tier: tier as any, limit: Number(req.query.limit) || 100 });
    }
    res.json({ tiers });
  });

  // Change memory tier
  router.put("/memory/:id/tier", (req, res) => {
    const { tier } = req.body;
    const validTiers = ['episodic', 'internalized', 'growth', 'core_identity'];
    if (!tier || !validTiers.includes(tier)) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` });
    }
    const all = queryMemories({ limit: 9999 });
    const mem = all.find(m => m.id === req.params.id);
    if (!mem) return res.status(404).json({ error: 'Memory not found' });

    if (tier === 'core_identity' && !req.body.confirmed) {
      return res.status(400).json({ error: 'Promoting to core_identity requires confirmed:true', currentTier: mem.tier, currentImportance: mem.importance });
    }

    removeMemory(mem.id);
    const updated = addMemory(
      {
        userId: mem.userId,
        type: mem.type,
        content: mem.content,
        keywords: mem.keywords,
        confidence: tier === 'core_identity' ? 1.0 : mem.confidence,
        sourceInteractionId: mem.sourceInteractionId,
      },
      { tier, perspective: mem.perspective, importance: tier === 'core_identity' ? Math.max(0.9, mem.importance) : mem.importance, parentId: mem.parentId },
    );
    broadcastMemoryChange(mem.userId, 'updated', updated.id);
    res.json({ success: true, memory: updated });
  });

  // Toggle core identity protection
  router.put("/memory/:id/protect", (req, res) => {
    const all = queryMemories({ limit: 9999 });
    const mem = all.find(m => m.id === req.params.id);
    if (!mem) return res.status(404).json({ error: 'Memory not found' });

    if (mem.tier === 'core_identity') {
      removeMemory(mem.id);
      const updated = addMemory(
        { userId: mem.userId, type: mem.type, content: mem.content, keywords: mem.keywords, confidence: mem.confidence, sourceInteractionId: mem.sourceInteractionId },
        { tier: 'growth', perspective: mem.perspective, importance: Math.min(0.8, mem.importance), parentId: mem.parentId },
      );
      broadcastMemoryChange(mem.userId, 'updated', updated.id);
      res.json({ success: true, protected: false, memory: updated });
    } else {
      removeMemory(mem.id);
      const updated = addMemory(
        { userId: mem.userId, type: mem.type, content: mem.content, keywords: mem.keywords, confidence: 1.0, sourceInteractionId: mem.sourceInteractionId },
        { tier: 'core_identity', perspective: mem.perspective, importance: Math.max(0.9, mem.importance), parentId: mem.parentId },
      );
      broadcastMemoryChange(mem.userId, 'updated', updated.id);
      res.json({ success: true, protected: true, memory: updated });
    }
  });
}
