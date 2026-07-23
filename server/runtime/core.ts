import express from "express";
import { logger } from '../lib/logger';
import { httpRequestsTotal, httpRequestDuration, getMetricsText } from '../lib/metrics';
import { touchActivity, startMainLoop } from '../core/mainLoop';
import cors from "cors";
import cookieParser from "cookie-parser";
import http from "http";
import { Server } from "socket.io";

export const asyncHandler = (fn: (req: express.Request, res: express.Response, next?: express.NextFunction) => Promise<any>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export interface AppContext {
  app: express.Express;
  server: http.Server;
  io: Server;
  apiRouter: express.Router;
  PORT: number;
  HOST: string;
  JWT_SECRET: string;
  getCookieOptions: () => { httpOnly: true; secure: boolean; sameSite: "none" | "lax"; maxAge: number };
}

export function createApp(): AppContext {
  const app = express();
  const server = http.createServer(app);

  const PORT = Number.parseInt(process.env.PORT || '', 10) || 3000;
  const HOST = process.env.HOST || "0.0.0.0";

  // CORS: allow local dev + NAS + Capacitor app
  const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,https://qweasd.top:4043,http://qweasd.top:3000,capacitor://localhost').split(',').map(s => s.trim());
  const corsOrigin = (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
    if (!origin || allowedOrigins.includes(origin)) { cb(null, true); }
    else { cb(new Error('Not allowed by CORS'), false); }
  };

  const io = new Server(server, {
    pingInterval: 60000,
    pingTimeout: 45000,
    cors: {
      origin: corsOrigin,
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  app.use(cors({ origin: corsOrigin, credentials: true }));
  // Capture raw body before JSON parse (needed for WeCom XML webhooks)
  app.use(express.json({
    limit: '10mb',
    verify: (req: any, _res, buf: Buffer) => { req.rawBody = buf.toString('utf8'); },
  }));
  app.use(cookieParser());

  const apiRouter = express.Router();

  // Ensure UTF-8 for API responses
  apiRouter.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
  });

  // HTTP metrics middleware — record all API requests
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path?.split('?')[0] || '/';
    // Reset idle timer for user activity (skip health/metrics probes)
    if (path !== '/health' && path !== '/metrics') touchActivity();
    res.on('finish', () => {
      const duration = (Date.now() - start) / 1000;
      const route = req.route?.path || path;
      try {
        httpRequestsTotal.inc({ method: req.method, route, status_code: String(res.statusCode) });
        httpRequestDuration.observe({ method: req.method, route }, duration);
      } catch {}
    });
    next();
  });

  // Middleware to log API requests for debugging
  apiRouter.use((req, res, next) => {
    logger.info(`[API_ROUTER] ${req.method} ${req.path}`);
    next();
  });

  // Mount API router early to ensure it catches requests before static/Vite middleware
  app.use("/api", apiRouter);

  // Global error handler for async route rejections
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('[Express] Unhandled error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Internal server error' });
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  app.get('/metrics', async (_req, res) => {
    try {
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(await getMetricsText());
    } catch {
      res.status(500).send('metrics unavailable');
    }
  });

  const JWT_SECRET = process.env.JWT_SECRET!;

  // Serialize personality file writes to prevent concurrent overwrites
  // SameSite=None requires Secure (Chromium silently rejects otherwise).
  // Chromium allows Secure cookies on localhost/127.0.0.1, so safe to always enable.
  const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
  const getCookieOptions = (): { httpOnly: true; secure: boolean; sameSite: "none" | "lax"; maxAge: number } => ({
    httpOnly: true,
    secure: !isDev,
    sameSite: isDev ? "lax" : "none",
    maxAge: 24 * 60 * 60 * 1000,
  });

  // Start resource-aware background scheduler
  startMainLoop();

  return { app, server, io, apiRouter, PORT, HOST, JWT_SECRET, getCookieOptions };
}
