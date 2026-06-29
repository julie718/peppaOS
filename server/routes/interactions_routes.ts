import { Router } from "express";
import { readDB, writeDB } from "../../db_layer";
import { requireAuth } from "../middleware/auth";

export function mountInteractionsRoutes(router: Router, _jwtSecret: string) {
  router.get("/interactions", requireAuth, (req, res) => {
    try {
      const db = readDB();
      const mode = req.query.mode as string | undefined;
      const limit = Number.parseInt(String(req.query.limit || ''), 10);
      let userInteractions = db.interactions.filter((i: any) => i.userId === req.user!.uid);
      if (mode) userInteractions = userInteractions.filter((i: any) => i.mode === mode);
      userInteractions = userInteractions
        .sort((a: any, b: any) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
      if (Number.isFinite(limit) && limit > 0) userInteractions = userInteractions.slice(0, Math.min(limit, 300));
      res.json(userInteractions);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/interactions", requireAuth, (req, res) => {
    try {
      const { content, role } = req.body;
      const db = readDB();
      const newInteraction = {
        id: Math.random().toString(36).substring(2, 15),
        userId: req.user!.uid,
        content,
        role,
        timestamp: new Date().toISOString()
      };
      db.interactions.push(newInteraction);
      writeDB(db);
      res.json(newInteraction);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}
