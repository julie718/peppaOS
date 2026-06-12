import { Router, Request, Response, NextFunction } from "express";
import { readDB, writeDB } from "../../db_layer";
import { requireAuth } from "../middleware/auth";

const asyncHandler = (fn: (req: Request, res: Response, next?: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

export function mountCanvasRoutes(router: Router, _jwtSecret: string) {
  // Create new canvas session
  router.post("/canvas/sessions", requireAuth, asyncHandler(async (req, res) => {
    const uid = req.user!.uid;
    const { title, taskText } = req.body || {};
    const now = new Date().toISOString();
    const session: any = {
      id: `canvas_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      userId: uid,
      title: title || '',
      cards: '[]',
      taskText: taskText || '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const db = readDB();
    if (!db.canvas_sessions) db.canvas_sessions = [];
    db.canvas_sessions.push(session);
    writeDB(db);
    res.json({ ...session, cards: [] });
  }));

  // List user's sessions
  router.get("/canvas/sessions", requireAuth, asyncHandler(async (req, res) => {
    const uid = req.user!.uid;
    const db = readDB();
    const sessions = (db.canvas_sessions || [])
      .filter((s: any) => s.userId === uid)
      .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((s: any) => ({
        id: s.id,
        title: s.title,
        taskText: s.taskText,
        status: s.status,
        cardCount: (() => { try { return JSON.parse(s.cards || '[]').length; } catch { return 0; } })(),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    res.json({ sessions });
  }));

  // Get single session with full cards
  router.get("/canvas/sessions/:id", requireAuth, asyncHandler(async (req, res) => {
    const uid = req.user!.uid;
    const { id } = req.params;
    const db = readDB();
    const session = (db.canvas_sessions || []).find((s: any) => s.id === id && s.userId === uid);
    if (!session) return res.status(404).json({ error: "Session not found" });
    let cards: any[] = [];
    try { cards = JSON.parse(session.cards || '[]'); } catch {}
    res.json({ ...session, cards });
  }));

  // Update session
  router.put("/canvas/sessions/:id", requireAuth, asyncHandler(async (req, res) => {
    const uid = req.user!.uid;
    const { id } = req.params;
    const db = readDB();
    const session = (db.canvas_sessions || []).find((s: any) => s.id === id && s.userId === uid);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (req.body.title !== undefined) session.title = req.body.title;
    if (req.body.taskText !== undefined) session.taskText = req.body.taskText;
    if (req.body.status !== undefined) session.status = req.body.status;
    if (req.body.cards !== undefined) {
      session.cards = typeof req.body.cards === 'string' ? req.body.cards : JSON.stringify(req.body.cards);
    }
    session.updatedAt = new Date().toISOString();
    writeDB(db);
    res.json({ success: true, updatedAt: session.updatedAt });
  }));

  // Delete session
  router.delete("/canvas/sessions/:id", requireAuth, asyncHandler(async (req, res) => {
    const uid = req.user!.uid;
    const { id } = req.params;
    const db = readDB();
    const idx = (db.canvas_sessions || []).findIndex((s: any) => s.id === id && s.userId === uid);
    if (idx === -1) return res.status(404).json({ error: "Session not found" });
    db.canvas_sessions.splice(idx, 1);
    writeDB(db);
    res.json({ success: true });
  }));
}
