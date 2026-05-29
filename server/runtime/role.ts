// Server role persistence — flat JSON config file (no DB dependency).
// Env LUMI_ROLE overrides everything. Without env, reads data/server_config.json.
// When a user creates an org, this file is written so the next restart picks up enterprise.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());
const CONFIG_PATH = path.join(ROOT, 'data', 'server_config.json');

export interface ServerConfig {
  role: 'personal' | 'enterprise';
  orgId: string | null;
  updatedAt: string;
}

export function resolveRole(): 'personal' | 'enterprise' {
  if (process.env.LUMI_ROLE === 'enterprise' || process.env.LUMI_ROLE === 'personal') {
    return process.env.LUMI_ROLE;
  }
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg: ServerConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.role === 'enterprise') return 'enterprise';
    }
  } catch {}
  return 'personal';
}

export function readConfig(): ServerConfig | null {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  return null;
}

export function persistRole(role: 'personal' | 'enterprise', orgId?: string): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cfg: ServerConfig = { role, orgId: orgId || null, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
