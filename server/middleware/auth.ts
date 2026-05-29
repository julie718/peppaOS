/**
 * Unified authentication middleware.
 *
 * Replaces the copy-pasted inline JWT verification pattern that appears
 * in 30+ route handlers across the codebase. New enterprise routes use
 * these middlewares. Existing routes continue with inline verification
 * (NOT retrofitted to minimize scope risk).
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  uid: string;
  username: string;
  role: string;        // 'user' | 'admin'
  orgId?: string;      // set when acting in org context
  orgRole?: string;    // 'owner' | 'admin' | 'member' | 'viewer'
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'lumiOS_default_jwt_secret_2026_local';

function extractToken(req: Request): string | null {
  let token = req.cookies?.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7);
  }
  return token || null;
}

function decodeToken(token: string): AuthUser | null {
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    return {
      uid: decoded.uid,
      username: decoded.username,
      role: decoded.role || 'user',
      orgId: decoded.orgId,
      orgRole: decoded.orgRole,
    };
  } catch {
    return null;
  }
}

/** Require valid JWT. Responds 401 if missing or invalid. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const user = decodeToken(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  req.user = user;
  next();
}

/** Optionally decode JWT. Sets req.user if valid, continues as anonymous if not. */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    const user = decodeToken(token);
    if (user) {
      req.user = user;
    }
  }
  next();
}

/** Require admin role (system-level, not org-level). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/** Require the user to be in org context with a specific org role. */
export function requireOrgRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!req.user.orgId) {
      res.status(403).json({ error: 'Organization context required. Use /api/auth/switch-org first.' });
      return;
    }
    if (!req.user.orgRole || !roles.includes(req.user.orgRole)) {
      res.status(403).json({ error: `Requires one of these org roles: ${roles.join(', ')}` });
      return;
    }
    next();
  };
}

/** Require that the user is a member of the org (any role). */
export function requireOrgMember(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!req.user.orgId) {
    res.status(403).json({ error: 'Organization context required. Use /api/auth/switch-org first.' });
    return;
  }
  next();
}
