/**
 * Auto-create a team agent when a skill is installed.
 *
 * Layer 1 of the two-layer design:
 *   Skill install → team agent created → Lumi can dispatch tasks to it
 *
 * Each installed skill becomes a named agent visible in the Skill Hall team tab.
 * The orchestrator's matchWorkers() finds them by skillTag overlap.
 */

import { readDB, writeDB } from "../../db_layer";

export function createAgentForSkill(
  skillName: string,
  skillInfo: {
    description?: string;
    category?: string;
    toolCount?: number;
    skillTags?: string[];
    installSource?: string;
    runtime?: 'internal' | 'external';
    externalCommand?: string;
  },
  io?: { emit: (event: string, data: any) => void },
): string | null {
  try {
    const db = readDB();
    if (!db.agents) db.agents = [];

    const agentId = `skill_${skillName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

    // Don't duplicate if already exists
    if (db.agents.find((a: any) => a.id === agentId)) return agentId;

    const category = mapCategory(skillInfo.category || 'general');
    const tags = skillInfo.skillTags || [skillName.toLowerCase(), category];
    const description = skillInfo.description || `Auto-generated agent for skill: ${skillName}`;
    const runtime = skillInfo.runtime || 'internal';
    const externalCommand = skillInfo.externalCommand;

    db.agents.push({
      id: agentId,
      name: skillName,
      category,
      config: JSON.stringify({ description, installSource: skillInfo.installSource || 'marketplace' }),
      data: '{}',
      createdAt: new Date().toISOString(),
      status: 'active',
      personalityId: 'lumi',
      modelPreference: '',
      memoryScope: 'shared',
      autonomyLevel: 'reactive',
      runtimeConfig: '{}',
      skillTags: tags,
      executionMode: 'lumi',
      allowCrossPollination: true,
      territory: 'open',
      runtime,
      ...(externalCommand ? { externalCommand } : {}),
      autoCreated: true,
    });

    writeDB(db);
    console.log(`[SkillAgent] Created team agent for skill "${skillName}" (id: ${agentId}, tags: ${tags.join(', ')})`);
    io?.emit('agent:created', { id: agentId, name: skillName, skillTags: tags });
    return agentId;
  } catch (err) {
    console.warn(`[SkillAgent] Failed to create agent for "${skillName}":`, (err as Error).message);
    return null;
  }
}

/** Map marketplace categories to orchestrator categories */
function mapCategory(cat: string): string {
  const lower = cat.toLowerCase();
  if (lower.includes('code') || lower.includes('dev') || lower.includes('programming')) return 'code';
  if (lower.includes('content') || lower.includes('writing') || lower.includes('media')) return 'content';
  if (lower.includes('analysis') || lower.includes('data') || lower.includes('research')) return 'analysis';
  if (lower.includes('search') || lower.includes('web') || lower.includes('fetch')) return 'search';
  if (lower.includes('automation') || lower.includes('desktop')) return 'automation';
  if (lower.includes('image') || lower.includes('video') || lower.includes('audio') || lower.includes('creative')) return 'media';
  return 'general';
}
