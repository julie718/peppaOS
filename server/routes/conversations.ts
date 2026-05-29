import { Router } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { readDB, writeDB } from "../../db_layer";
import {
  getUserConversations,
  getMessages,
  closeConversation,
  getActiveConversation,
} from "../conversation/manager";

export function mountConversationRoutes(router: Router, _jwtSecret: string) {
  router.get("/conversations", requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const conversations = getUserConversations(req.user!.uid, limit, offset);
    res.json({ conversations, limit, offset });
  });

  router.get("/conversations/active", requireAuth, (req, res) => {
    const activeConversation = getActiveConversation(req.user!.uid);
    res.json({ activeConversation });
  });

  router.get("/conversations/:id/messages", requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const messages = getMessages(req.params.id, limit);
    res.json({ messages });
  });

  router.post("/conversations/:id/close", requireAuth, (req, res) => {
    const { summary } = req.body || {};
    const conv = closeConversation(req.params.id, summary);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    res.json({ success: true, conversation: conv });
  });

  router.delete("/conversations/:id", requireAuth, (req, res) => {
    const db = readDB();
    if (!db.conversations) return res.status(404).json({ error: "Not found" });
    const idx = db.conversations.findIndex((c: any) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    db.conversations.splice(idx, 1);
    if (db.interactions) {
      db.interactions = db.interactions.filter((i: any) => i.conversationId !== req.params.id);
    }
    writeDB(db);
    res.json({ success: true });
  });
}
