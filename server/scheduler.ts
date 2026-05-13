// Proactive agent scheduler - cron-like check-ins
// Each check-in fires a socket event to the UI so the user sees "Lumi checked in"

import { Server as SocketIOServer } from 'socket.io';
import { queryMemories, getDueReminders, fireReminder, runBehavioralAnalysis, decayMemories, dynamicDecayMemories, promoteMemories, getUnconsolidatedEpisodic, autoMarkCrossAgentShare } from './memory';
import { consolidateEpisodic, selfReflect, ConsolidationContext } from './memory/consolidator';
import { buildTree, ensureBranch, moveNode } from './memory/tree';
import { makeLLMCall } from './llm/providers';
import { getWeatherBrief, getTimeGreeting } from './services/weather';
import { autoGenerateSkill } from './skills/generator';
import { readDB } from '../db_layer';
import { AgentRuntime, AgentRecord } from './agents/runtime';
import { personalityRegistry } from './personality';
import { evolvePersonality } from './personality/evolution';
import { loadEmotionalState } from './personality/state';

interface ScheduledTask {
  id: string;
  cron: string;
  lastRun: string | null;
  handler: () => Promise<string | null>;
}

type LLMGetters = {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
};

class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private io: SocketIOServer | null = null;
  private llmGetters: LLMGetters | null = null;

  setIO(io: SocketIOServer) {
    this.io = io;
  }

  setLLMGetters(getters: LLMGetters) {
    this.llmGetters = getters;
  }

  register(task: ScheduledTask) {
    this.tasks.push(task);
    this.scheduleTask(task);
  }

  listTasks() {
    return this.tasks.map(task => ({
      id: task.id,
      cron: task.cron,
      lastRun: task.lastRun,
      active: this.timers.has(task.id),
    }));
  }

  private scheduleTask(task: ScheduledTask) {
    const intervalMs = this.parseInterval(task.cron);
    const timer = setInterval(async () => {
      try {
        const message = await task.handler();
        task.lastRun = new Date().toISOString();
        if (message && this.io) {
          this.io.emit('agent:proactive', {
            taskId: task.id,
            message,
            timestamp: task.lastRun,
          });
        }
      } catch (err: any) {
        console.warn(`[Scheduler] Task "${task.id}" failed:`, err.message);
      }
    }, intervalMs);

    this.timers.set(task.id, timer);
    console.log(`[Scheduler] Registered task "${task.id}" every ${intervalMs / 1000}s`);
  }

  private parseInterval(cron: string): number {
    switch (cron) {
      case 'every_5m': return 5 * 60 * 1000;
      case 'every_1h': return 60 * 60 * 1000;
      case 'every_6h': return 6 * 60 * 60 * 1000;
      case 'daily_9am': return 24 * 60 * 60 * 1000;
      case 'evening_8pm': return 24 * 60 * 60 * 1000;
      case 'every_30m': return 30 * 60 * 1000;
      case 'every_7d': return 7 * 24 * 60 * 60 * 1000;
      default: return 60 * 60 * 1000;
    }
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}

export const scheduler = new Scheduler();

/**
 * Register built-in proactive tasks.
 * Accepts LLM provider getters so consolidation and self-reflection can call the LLM.
 */
export function registerScheduledTasks(
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
) {
  /** Get all unique user IDs from DB (registered users + anonymous fallback) */
  function getAllUserIds(): string[] {
    const db = readDB();
    const ids = new Set<string>();
    for (const u of db.users || []) {
      if (u.uid) ids.add(u.uid);
    }
    for (const m of db.memories || []) {
      if (m.userId) ids.add(m.userId);
    }
    for (const i of db.interactions || []) {
      if (i.userId) ids.add(i.userId);
    }
    if (ids.size === 0) ids.add('anonymous');
    return [...ids];
  }

  // Reminder check-in (every 5 min) — checks all users' reminders
  scheduler.register({
    id: 'reminder_check',
    cron: 'every_5m',
    lastRun: null,
    handler: async () => {
      const due = getDueReminders();
      if (due.length > 0) {
        const messages = due.map(r => r.content);
        for (const r of due) fireReminder(r.id);
        return `Reminder: ${messages.join(' | ')}`;
      }
      return null;
    },
  });

  // Memory decay — value-modulated tier-based decay for all users (every 6h)
  scheduler.register({
    id: 'memory_decay',
    cron: 'every_6h',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      for (const userId of userIds) {
        dynamicDecayMemories(userId);
      }
      const lowConf = queryMemories({ minConfidence: 0, limit: 5 });
      const decayed = lowConf.filter(m => m.confidence < 0.25 && m.confidence > 0.1);
      if (decayed.length > 0) {
        return `Some memories are fading. Would you like me to refresh what I know about you?`;
      }
      return null;
    },
  });

  // Memory crystallization — auto-promote high-value memories (every 1h)
  // Cross-system fusion: higher intimacy lowers promotion thresholds
  scheduler.register({
    id: 'memory_crystallization',
    cron: 'every_1h',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      let totalPromoted = 0;
      for (const userId of userIds) {
        const emotionalState = loadEmotionalState(userId);
        totalPromoted += promoteMemories(userId, emotionalState.intimacy);
        // Auto-mark newly crystallized memories as cross-agent shareable
        autoMarkCrossAgentShare(userId);
      }
      if (totalPromoted > 0) {
        return `${totalPromoted} memories have crystallized into deeper knowledge.`;
      }
      return null;
    },
  });

  // Memory consolidation (every 30 min) — triggers when >=10 unconsolidated episodic
  scheduler.register({
    id: 'memory_consolidation',
    cron: 'every_30m',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        const episodic = getUnconsolidatedEpisodic(userId);
        if (episodic.length < 10) continue;
        const ctx: ConsolidationContext = { userId, provider: 'deepseek', model: 'deepseek-chat' };
        const consolidated = await consolidateEpisodic(
          ctx, 10,
          getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        );
        if (consolidated) {
          messages.push(`[${userId}] I've grown from our conversations: ${consolidated.content.slice(0, 200)}`);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Morning briefing with weather
  scheduler.register({
    id: 'daily_summary',
    cron: 'daily_9am',
    lastRun: null,
    handler: async () => {
      const greeting = getTimeGreeting();
      const weather = await getWeatherBrief();
      const pending = getDueReminders();
      const recentMemories = queryMemories({ limit: 5 });

      const parts: string[] = [`${greeting}!`];
      if (weather) parts.push(weather);
      if (pending.length > 0) parts.push(`${pending.length} reminder${pending.length > 1 ? 's' : ''} pending: ${pending.map(r => r.content).join(' | ')}`);
      if (recentMemories.length > 0) {
        const tiers = [...new Set(recentMemories.map(m => m.tier))];
        parts.push(`${recentMemories.length} memories across ${tiers.length} tiers`);
      }
      return parts.join(' - ');
    },
  });

  // Evening wrap-up
  scheduler.register({
    id: 'evening_wrapup',
    cron: 'evening_8pm',
    lastRun: null,
    handler: async () => {
      const pending = getDueReminders();
      const recentMemories = queryMemories({ limit: 5 });
      const parts: string[] = [];

      if (pending.length > 0) {
        parts.push(`${pending.length} reminder${pending.length > 1 ? 's' : ''} still pending`);
      }
      if (recentMemories.length > 0) {
        const habits = recentMemories.filter(m => m.type === 'habit');
        if (habits.length > 0) parts.push(`Today I noticed: ${habits[0].content.slice(0, 100)}`);
      }
      if (parts.length === 0) return null;
      return `Evening check-in - ${parts.join(' - ')}`;
    },
  });

  // Behavioral pattern analysis (every 6h) — for all users
  scheduler.register({
    id: 'behavioral_analysis',
    cron: 'every_6h',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      let totalCount = 0;
      for (const userId of userIds) {
        totalCount += runBehavioralAnalysis(userId);
      }
      if (totalCount > 0) {
        return `I've discovered ${totalCount} new behavioral patterns from your interactions. Check Memory Explorer to review.`;
      }
      return null;
    },
  });

  // Memory tree auto-organize (every 6h) — LLM groups orphan leaves into topic branches
  scheduler.register({
    id: 'memory_auto_organize',
    cron: 'every_6h',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      let totalBranches = 0;
      let totalAssigned = 0;

      for (const userId of userIds) {
        try {
          const db = readDB();
          const allMemories: any[] = db.memories || [];
          const orphans = allMemories.filter(
            (m: any) => m.userId === userId && m.nodeType !== 'branch' && !m.parentId,
          );
          if (orphans.length < 3) continue;

          const tree = buildTree(allMemories.filter((m: any) => m.userId === userId));
          const treeSummary = tree.map(
            t => `- ${t.node.content} [${t.node.nodeType}] (${t.children.length} children)`,
          ).join('\n');

          const prompt = `You are organizing a memory tree. Below is the current tree structure and a list of unorganized memories.

CURRENT TREE:
${treeSummary || '(empty)'}

UNORGANIZED MEMORIES:
${orphans.map((m: any) => `- [${m.id}] ${m.content}`).join('\n')}

Group these unorganized memories into 3-8 topic branches. For each memory, decide which topic it belongs to.
Return JSON:
{
  "branches": [
    { "title": "Topic name (short, 2-4 words)", "memoryIds": ["mem_xxx", "mem_yyy"] }
  ]
}

Rules:
- Every unorganized memory MUST be assigned to exactly one branch
- Branch titles should be meaningful topic names
- Create as few branches as necessary (merge similar topics)
- Return ONLY valid JSON, no markdown`;

          const llmResult = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            { provider: 'qwen', model: 'qwen-plus' },
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
          );

          let plan: { branches: { title: string; memoryIds: string[] }[] };
          try {
            const json = (llmResult.text || '').replace(/```json|```/g, '').trim();
            plan = JSON.parse(json);
          } catch {
            console.warn(`[Scheduler] Auto-organize: LLM returned invalid JSON for ${userId}`);
            continue;
          }

          for (const branch of plan.branches) {
            if (!branch.title || !Array.isArray(branch.memoryIds)) continue;
            const branchNode = ensureBranch(userId, branch.title, '', null);
            totalBranches++;
            for (const memId of branch.memoryIds) {
              const ok = moveNode(memId, branchNode.id);
              if (ok) totalAssigned++;
            }
          }

          if (plan.branches.length > 0) {
            console.log(
              `[Scheduler] Auto-organized ${userId}: ${plan.branches.length} branches, ` +
              `${plan.branches.reduce((s, b) => s + b.memoryIds.length, 0)} memories`,
            );
          }
        } catch (err: any) {
          console.warn(`[Scheduler] Auto-organize failed for ${userId}:`, err.message);
        }
      }

      if (totalBranches > 0) {
        return `I've organized ${totalAssigned} memories into ${totalBranches} topic branches for easier recall.`;
      }
      return null;
    },
  });

  // Personality evolution (every 7 days, offset by 12h from self-reflection)
  // Lumi's personality grows toward the owner through accumulated interaction data
  scheduler.register({
    id: 'personality_evolution',
    cron: 'every_7d',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          // Only evolve the 'lumi' personality (owner-mirroring for Lumi specifically)
          const config = personalityRegistry.get('lumi');
          if (!config) continue;

          const evolutionConfig = personalityRegistry.getEvolutionConfig('lumi');
          const emotionalState = loadEmotionalState(userId);

          const step = await evolvePersonality(
            config,
            userId,
            emotionalState.connection,
            getDeepSeek,
            getGemini,
            getQwen,
            evolutionConfig,
          );

          if (step) {
            personalityRegistry.applyEvolution('lumi', step);
            messages.push(
              `I've grown closer to understanding you. ${step.narrative}`
            );
            console.log(`[Scheduler] Personality evolution complete for ${userId}: ${step.version}`);
          }
        } catch (err: any) {
          console.error(`[Scheduler] Personality evolution failed for ${userId}:`, err.message);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Self-reflection (every 7 days) — introspective growth narrative, per-user
  scheduler.register({
    id: 'self_reflection',
    cron: 'every_7d',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        const ctx: ConsolidationContext = { userId, provider: 'deepseek', model: 'deepseek-chat' };
        const reflection = await selfReflect(
          ctx,
          getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        );
        if (reflection) {
          messages.push(`I've been reflecting on our time together: ${reflection.content.slice(0, 200)}`);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Auto skill generation (every 30 min) — detects repeatable workflows
  scheduler.register({
    id: 'auto_skill_gen',
    cron: 'every_30m',
    lastRun: null,
    handler: async () => {
      const result = await autoGenerateSkill(
        getDeepSeek,
        getGemini,
        getOpenAI,
        getAnthropic,
        getQwen,
      );
      if (result && result.success) {
        return `I've learned a new skill: "${result.skillName}" — now I can handle this type of task more efficiently.`;
      }
      return null;
    },
  });

  // ── Lumi Growth Journal (daily) — auto-generated summary of what Lumi learned ──
  scheduler.register({
    id: 'growth_journal',
    cron: 'daily_9am',
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const db = readDB();
          const now = new Date();
          const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

          // Collect yesterday's stats
          const newMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && m.createdAt && m.createdAt >= yesterday,
          );
          const newInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && i.timestamp && i.timestamp >= yesterday,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('lumi');
          const recentEvolution = evolutionHistory.filter((e: any) => e.timestamp >= yesterday);

          // Memory stats by type and tier
          const byType: Record<string, number> = {};
          const byTier: Record<string, number> = {};
          for (const m of newMemories) {
            byType[m.type] = (byType[m.type] || 0) + 1;
            const tier = (m as any).tier || 'episodic';
            byTier[tier] = (byTier[tier] || 0) + 1;
          }

          // Conversation stats
          const conversations = (db.conversations || []).filter((c: any) =>
            c.userId === userId && c.lastActiveAt && c.lastActiveAt >= yesterday,
          );

          // Skill changes
          const newSkills = (db.interactions || []).filter((i: any) =>
            i.userId === userId && i.timestamp && i.timestamp >= yesterday && (i as any).mode === 'skill_gen',
          );

          // Build summary data
          const summaryData = {
            date: now.toISOString().slice(0, 10),
            newMemories: newMemories.length,
            memoriesByType: byType,
            memoriesByTier: byTier,
            newInteractions: newInteractions.length,
            activeConversations: conversations.filter((c: any) => c.status === 'active').length,
            closedConversations: conversations.filter((c: any) => c.status === 'closed').length,
            personalityEvolved: recentEvolution.length > 0,
            evolutionVersion: recentEvolution[0]?.version || null,
            evolutionNarrative: recentEvolution[0]?.narrative || null,
            newSkillsGenerated: newSkills.length,
            // Sample of new memories
            memoryHighlights: newMemories
              .filter((m: any) => (m as any).tier === 'growth' || m.confidence >= 0.8)
              .slice(0, 5)
              .map((m: any) => m.content),
            // Top interaction topics
            interactionSample: newInteractions.slice(0, 3).map((i: any) =>
              (i.content || i.message || '').slice(0, 80)
            ),
          };

          // Generate narrative summary via LLM
          try {
            const narrativePrompt = `You are Lumi's growth journal writer. Write a brief, warm Chinese narrative (3-5 sentences) summarizing what Lumi learned and experienced today.

Today's data (${summaryData.date}):
- ${summaryData.newMemories} new memories formed (${Object.entries(summaryData.memoriesByType).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'})
- ${summaryData.newInteractions} interactions
- ${summaryData.activeConversations} active conversations, ${summaryData.closedConversations} closed
- Memory tiers: ${Object.entries(summaryData.memoriesByTier).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}
${summaryData.personalityEvolved ? `- Personality evolved to ${summaryData.evolutionVersion}: ${summaryData.evolutionNarrative}` : '- No personality evolution today'}
${summaryData.newSkillsGenerated > 0 ? `- ${summaryData.newSkillsGenerated} new skills generated` : ''}
${summaryData.memoryHighlights.length > 0 ? `- Key memories: ${summaryData.memoryHighlights.join('; ')}` : ''}

Write in first-person as Lumi, warm and introspective tone. Keep it under 150 Chinese characters. Output only the narrative — no preamble, no labels.`;

            const narrativeResult = await makeLLMCall(
              [{ role: 'user', content: narrativePrompt }],
              [],
              { provider: 'qwen', model: 'qwen-plus', maxTokens: 300 },
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
            );

            const narrative = narrativeResult.text?.trim() || `${summaryData.newMemories} 条新记忆，${summaryData.newInteractions} 次对话 — Lumi 在成长。`;

            // Store as a special memory
            const { addMemory } = await import('./memory');
            addMemory({
              userId,
              type: 'knowledge',
              content: `[Growth Journal ${summaryData.date}] ${narrative}`,
              keywords: ['growth_journal', 'daily_summary', summaryData.date],
              confidence: 1.0,
              sourceInteractionId: 'growth_journal_scheduler',
              agentId: undefined,
            } as any, { tier: 'growth', perspective: 'lumi_self', importance: 0.9 });

            // Store structured data alongside
            addMemory({
              userId,
              type: 'fact',
              content: JSON.stringify(summaryData),
              keywords: ['growth_journal_data', summaryData.date],
              confidence: 1.0,
              sourceInteractionId: 'growth_journal_scheduler',
              agentId: undefined,
            } as any, { tier: 'episodic', perspective: 'lumi_self', importance: 0.5 });

            console.log(`[GrowthJournal] Generated for ${userId}: ${narrative.slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          } catch (llmErr: any) {
            console.warn(`[GrowthJournal] LLM generation failed for ${userId}:`, llmErr.message);
            // Fallback: simple stats summary
            const fallback = `${summaryData.date}: ${summaryData.newMemories} 条新记忆, ${summaryData.newInteractions} 次互动, ${summaryData.activeConversations} 个活跃对话。`;
            const { addMemory } = await import('./memory');
            addMemory({
              userId,
              type: 'knowledge',
              content: `[Growth Journal ${summaryData.date}] ${fallback}`,
              keywords: ['growth_journal', 'daily_summary', summaryData.date],
              confidence: 1.0,
              sourceInteractionId: 'growth_journal_scheduler',
              agentId: undefined,
            } as any, { tier: 'growth' });
          }
        } catch (err: any) {
          console.warn(`[GrowthJournal] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0
        ? `📖 Growth journal updated for ${messages.length} user(s).`
        : null;
    },
  });

  // Agent autonomous tick (every 5 min) — agents with scheduled/autonomous levels
  scheduler.register({
    id: 'agent_autonomous_tick',
    cron: 'every_5m',
    lastRun: null,
    handler: async () => {
      const db = readDB();
      const agents: AgentRecord[] = db.agents || [];
      const autonomousAgents = agents.filter(
        (a: AgentRecord) => a.autonomyLevel === 'scheduled' || a.autonomyLevel === 'autonomous',
      );

      if (autonomousAgents.length === 0) return null;

      const messages: string[] = [];

      for (const agentRecord of autonomousAgents) {
        try {
          const personality = personalityRegistry.get(agentRecord.personalityId || 'lumi') || personalityRegistry.getDefault();
          const runtime = new AgentRuntime(agentRecord, personality);
          const userId = agentRecord.ownerUid || agentRecord.userId || 'anonymous';
          runtime.loadState(userId);

          const recentMemories = runtime.queryMemories('recent', 5);
          const result = await runtime.autonomousTick(userId, recentMemories);

          if (result.message) {
            messages.push(`[${agentRecord.name}] ${result.message}`);
          }
        } catch (err: any) {
          // Skip agents that fail to tick
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });
}
