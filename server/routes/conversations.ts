import { Router } from "express";
import jwt from "jsonwebtoken";
import { readDB, writeDB } from "../../db_layer";
import {
  getUserConversations,
  getMessages,
  closeConversation,
  getActiveConversation,
} from "../conversation/manager";

export function mountConversationRoutes(router: Router, jwtSecret: string) {
  // List conversations for current user
  router.get("/conversations", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const conversations = getUserConversations(decoded.uid, 30);
      res.json({ conversations });
    } catch (err: any) {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  // Get active conversation
  router.get("/conversations/active", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const activeConversation = getActiveConversation(decoded.uid);
      res.json({ activeConversation });
    } catch (err: any) {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  // Get messages for a conversation
  router.get("/conversations/:id/messages", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const limit = parseInt(req.query.limit as string) || 100;
      const messages = getMessages(req.params.id, limit);
      res.json({ messages });
    } catch (err: any) {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  // Close a conversation
  router.post("/conversations/:id/close", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      jwt.verify(token, jwtSecret);
      const conv = closeConversation(req.params.id);
      res.json({ success: true, conversation: conv });
    } catch (err: any) {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  // Delete a conversation
  router.delete("/conversations/:id", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      jwt.verify(token, jwtSecret);
      const db = readDB();
      if (!db.conversations) return res.status(404).json({ error: "Not found" });
      const idx = db.conversations.findIndex((c: any) => c.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: "Not found" });
      db.conversations.splice(idx, 1);
      // Also clean up related interactions
      if (db.interactions) {
        db.interactions = db.interactions.filter((i: any) => i.conversationId !== req.params.id);
      }
      writeDB(db);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get chat history for a specific agent
  router.get("/agents/:agentId/history", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const db = readDB();
      const agentId = req.params.agentId;
      const interactions = (db.interactions || [])
        .filter((i: any) => i.userId === decoded.uid && i.agentId === agentId)
        .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-100);

      const messages = [];
      for (const i of interactions) {
        if (i.message) {
          messages.push({
            id: i.id + "_u",
            role: "user",
            content: i.message,
            timestamp: i.timestamp,
          });
        }
        if (i.response) {
          messages.push({
            id: i.id + "_r",
            role: "assistant",
            content: i.response,
            timestamp: i.timestamp,
          });
        }
      }
      res.json(messages);
    } catch (err: any) {
      res.status(401).json({ error: "Invalid token" });
    }
  });
}
