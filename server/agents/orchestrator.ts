/**
 * Lumi Master Brain Orchestrator
 *
 * Lumi receives tasks → judges complexity → handles simple ones directly →
 * decomposes complex ones into sub-tasks → dispatches to worker agents →
 * aggregates results → optionally distills pattern into a reusable skill.
 *
 * Anti-entropy design:
 * - Each worker loads only its own memory + sub-task context (context isolation)
 * - Complex reusable patterns are auto-distilled into MCP skills (skill distillation)
 * - Valuable outputs crystallize into growth-tier memories (memory crystallization)
 */

import { readDB } from "../../db_layer";
import { NormalizedMessage, makeLLMCall } from "../llm/providers";
import { queryMemories, addMemory } from "../memory/store";
import { Memory } from "../memory/types";
import { AgentRecord } from "./runtime";
import { recordWorkflow } from "../skills/worklog";
import { personalityRegistry } from "../personality";

type LLMProvider = 'deepseek' | 'gemini' | 'openai' | 'anthropic' | 'qwen';

export interface LlmGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
}

// ── Types ──

export type TaskComplexity = 'simple' | 'moderate' | 'complex';

export interface SubTask {
  id: string;
  description: string;
  requiredSkill: 'code' | 'writing' | 'analysis' | 'search' | 'general';
  executionMode: 'lumi' | 'scholar' | 'founder';
  dependsOn?: string[];
  assignedAgentId?: string;
}

export interface WorkerAssignment {
  subTask: SubTask;
  agent: AgentRecord;
}

export interface WorkflowResult {
  subTaskResults: Array<{ subTaskId: string; output: string; agentId: string }>;
  aggregatedOutput: string;
  totalAgentsUsed: number;
}

export interface OrchestrationContext {
  userId: string;
  personalityId?: string;
  availableAgentIds?: string[];
}

// ── Complexity classification ──

/** Heuristic keywords that suggest a task needs decomposition */
const COMPLEX_SIGNALS = [
  'build', 'create a', 'implement', 'design and', 'refactor the',
  'set up', 'configure', 'deploy', 'migrate', 'analyze and',
  '全部', '所有', '整个', '重构', '部署', '迁移', '实现', '设计并',
  '帮我写一个', '帮我做一个', '帮我搭建',
];

const MODERATE_SIGNALS = [
  'explain', 'compare', 'review', 'summarize', 'find all',
  '解释', '比较', '总结', '检查', '查找',
];

/**
 * Classify task complexity using fast local heuristics.
 * For ambiguous cases, LLM classification can be invoked separately.
 */
export function classifyComplexity(
  text: string,
  context: OrchestrationContext,
): TaskComplexity {
  const lower = text.toLowerCase();

  // Multi-sentence / multi-clause tasks are at least moderate
  const sentenceCount = text.split(/[.。!！?？\n]+/).filter(s => s.trim().length > 0).length;
  const wordCount = text.split(/\s+/).length;

  // Strong complex signals
  const complexMatches = COMPLEX_SIGNALS.filter(s => lower.includes(s.toLowerCase()));
  if (complexMatches.length >= 1 && sentenceCount >= 2) return 'complex';
  if (complexMatches.length >= 2) return 'complex';
  if (wordCount > 80 && sentenceCount >= 3) return 'complex';

  // Moderate signals
  const moderateMatches = MODERATE_SIGNALS.filter(s => lower.includes(s.toLowerCase()));
  if (moderateMatches.length >= 1 && sentenceCount >= 2) return 'moderate';
  if (wordCount > 40 && sentenceCount >= 2) return 'moderate';

  return 'simple';
}

// ── Task decomposition (LLM-powered) ──

const DECOMPOSE_PROMPT = `You are a task decomposition engine. Break the user's request into independent sub-tasks that can be executed by separate worker agents.

Rules:
- Each sub-task should be self-contained and independently executable
- If sub-tasks have dependencies, mark them with dependsOn
- Assign each sub-task a requiredSkill: code, writing, analysis, search, or general
- Assign an executionMode: scholar (technical/analytical), founder (creative/strategic), or lumi (default)
- Produce 2-5 sub-tasks. Do NOT over-decompose.
- Output ONLY valid JSON array — no explanation, no markdown fences.

User request: {task}

Output format:
[
  {
    "id": "sub_1",
    "description": "what this worker should do",
    "requiredSkill": "code",
    "executionMode": "scholar",
    "dependsOn": []
  }
]`;

/**
 * Decompose a complex task into sub-tasks via LLM.
 */
export async function decomposeTask(
  text: string,
  config: { provider: LLMProvider; model: string },
  context: OrchestrationContext,
  llmGetters: LlmGetters,
): Promise<SubTask[]> {
  const prompt = DECOMPOSE_PROMPT.replace('{task}', text);

  try {
    const messages: NormalizedMessage[] = [{ role: 'user', content: prompt }];
    const result = await makeLLMCall(
      messages,
      [],
      { provider: config.provider, model: config.model, maxTokens: 2000 },
      llmGetters.getDeepSeek,
      llmGetters.getGemini,
      llmGetters.getOpenAI,
      llmGetters.getAnthropic,
      llmGetters.getQwen,
    );

    // Parse JSON from the response (handle markdown code fences)
    let json = result.text.trim();
    if (json.startsWith('```')) {
      json = json.replace(/```(?:json)?\n?/g, '').trim();
    }
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('Expected array');

    return parsed.map((item: any, idx: number) => ({
      id: item.id || `sub_${idx + 1}`,
      description: item.description || '',
      requiredSkill: item.requiredSkill || 'general',
      executionMode: item.executionMode || 'lumi',
      dependsOn: item.dependsOn || [],
    }));
  } catch (err) {
    console.error('[Orchestrator] Decomposition failed, treating as simple:', err);
    // Fallback: single sub-task = the original request
    return [{
      id: 'sub_1',
      description: text,
      requiredSkill: 'general',
      executionMode: 'lumi',
    }];
  }
}

// ── Worker matching ──

const SKILL_TO_CATEGORY: Record<string, string> = {
  code: 'code',
  writing: 'content',
  analysis: 'analysis',
  search: 'search',
  general: 'general',
};

// ── Smart routing cache: remembers which agent succeeded at which skill ──
// skillTag → { agentId → successCount }
const routingCache = new Map<string, Map<string, number>>();
const ROUTING_CACHE_MAX_AGE_MS = 7 * 86400000; // 7 days

function recordRoutingSuccess(skillTag: string, agentId: string): void {
  if (!routingCache.has(skillTag)) {
    routingCache.set(skillTag, new Map());
  }
  const agentScores = routingCache.get(skillTag)!;
  agentScores.set(agentId, (agentScores.get(agentId) || 0) + 1);
}

function getRoutingScore(skillTag: string, agentId: string): number {
  const agentScores = routingCache.get(skillTag);
  return agentScores?.get(agentId) || 0;
}

/**
 * Match sub-tasks to available worker agents by skill compatibility.
 * If no suitable agent exists, returns the best generalist agent.
 */
export function matchWorkers(
  subTasks: SubTask[],
  availableAgents: AgentRecord[],
): WorkerAssignment[] {
  const assignments: WorkerAssignment[] = [];

  for (const subTask of subTasks) {
    const targetCategory = SKILL_TO_CATEGORY[subTask.requiredSkill] || 'general';
    const taskTokens = subTask.description.toLowerCase().split(/\s+/);

    // Score every available agent, pick the best
    let bestAgent: AgentRecord | null = null;
    let bestScore = -1;

    for (const agent of availableAgents) {
      let score = 0;

      // Category match (primary, weight 10)
      if (agent.category === targetCategory) score += 10;
      // Idle bonus
      if (agent.status === 'idle') score += 3;

      // Skill tag overlap (secondary, weight 5 per match)
      if (agent.skillTags && agent.skillTags.length > 0) {
        for (const tag of agent.skillTags) {
          for (const token of taskTokens) {
            if (tag.toLowerCase().includes(token) || token.includes(tag.toLowerCase())) {
              score += 5;
            }
          }
        }
      }

      // Routing cache bonus: prefer agents that succeeded at this skill before
      const routingBonus = getRoutingScore(subTask.requiredSkill, agent.id);
      if (routingBonus > 0) score += Math.min(routingBonus * 2, 8);

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    if (!bestAgent) {
      // Auto-create ephemeral worker agent when none matches
      bestAgent = createEphemeralAgent(targetCategory, subTask.requiredSkill);
    }

    if (bestAgent) {
      assignments.push({ subTask, agent: bestAgent });
    }
  }

  return assignments;
}

/** Auto-create a minimal ephemeral agent for a one-shot task */
function createEphemeralAgent(category: string, skillTag: string): AgentRecord {
  const id = `ephemeral_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const agent: AgentRecord = {
    id,
    name: `${category}-worker`,
    category,
    config: '{}',
    data: '{}',
    createdAt: new Date().toISOString(),
    status: 'idle',
    modelPreference: 'qwen-plus',
    memoryScope: 'private',
    autonomyLevel: 'reactive',
    runtimeConfig: '{}',
    skillTags: [skillTag],
    executionMode: 'lumi',
    allowCrossPollination: false,
  };
  // Persist to DB so it's visible
  try {
    const db = readDB();
    if (!db.agents) db.agents = [];
    db.agents.push(agent as any);
    // Note: ephemeral agents are cleaned up by the scheduler or on restart
  } catch (err) {
    // Non-critical — agent works in-memory even without DB persistence
  }
  return agent;
}

// ── Workflow execution ──

/**
 * Resolve a topological execution order respecting dependsOn.
 * Returns groups of sub-tasks that can run in parallel.
 */
function topologicalGroups(assignments: WorkerAssignment[]): WorkerAssignment[][] {
  const completed = new Set<string>();
  const remaining = [...assignments];
  const groups: WorkerAssignment[][] = [];

  while (remaining.length > 0) {
    const ready: WorkerAssignment[] = [];
    const stillWaiting: WorkerAssignment[] = [];

    for (const a of remaining) {
      const deps = a.subTask.dependsOn || [];
      if (deps.every(d => completed.has(d))) {
        ready.push(a);
      } else {
        stillWaiting.push(a);
      }
    }

    if (ready.length === 0 && stillWaiting.length > 0) {
      // Circular dependency or all deps unresolved — execute remaining as a batch
      groups.push(stillWaiting);
      break;
    }

    groups.push(ready);
    for (const a of ready) completed.add(a.subTask.id);
    remaining.length = 0;
    remaining.push(...stillWaiting);
  }

  return groups;
}

/**
 * Execute a single worker task.
 * Each worker loads only its own context (anti-entropy: context isolation).
 */
async function executeWorkerTask(
  assignment: WorkerAssignment,
  context: OrchestrationContext,
  llmConfig: { provider: LLMProvider; model: string },
  llmGetters: LlmGetters,
): Promise<{ subTaskId: string; output: string; agentId: string }> {
  const { subTask, agent } = assignment;

  // Context isolation: worker only loads its own memories + sub-task description
  const workerMemories = queryMemories({
    userId: context.userId,
    query: subTask.description,
    limit: 3,
    minConfidence: 0.3,
    agentId: agent.id,
  });

  const memoryContext = workerMemories.length > 0
    ? workerMemories.map(m => `- ${m.content.slice(0, 200)}`).join('\n')
    : '';

  // Load Lumi's executionMode preset for scholar/founder prompt extensions
  let modeDirective = '';
  if (subTask.executionMode !== 'lumi') {
    const lumiConfig = personalityRegistry.get('lumi');
    const mode = lumiConfig?.executionModes?.[subTask.executionMode];
    if (mode?.promptExtension) {
      modeDirective = mode.promptExtension;
    }
  }

  const workerPrompt = [
    `You are worker agent "${agent.name}" (${agent.category}).`,
    `Task: ${subTask.description}`,
    modeDirective,
    memoryContext ? `Relevant memories:\n${memoryContext}` : '',
    'Complete this sub-task. Output your result directly — no preamble.',
  ].filter(Boolean).join('\n\n');

  try {
    const messages: NormalizedMessage[] = [{ role: 'user', content: workerPrompt }];
    const result = await makeLLMCall(
      messages,
      [],
      { provider: llmConfig.provider, model: llmConfig.model, maxTokens: 1500 },
      llmGetters.getDeepSeek,
      llmGetters.getGemini,
      llmGetters.getOpenAI,
      llmGetters.getAnthropic,
      llmGetters.getQwen,
    );

    return {
      subTaskId: subTask.id,
      output: result.text.trim(),
      agentId: agent.id,
    };
  } catch (err) {
    return {
      subTaskId: subTask.id,
      output: `[Worker ${agent.name} failed: ${String(err)}]`,
      agentId: agent.id,
    };
  }
}

/**
 * Execute the full workflow: topological sort → parallel groups → aggregate.
 */
export async function executeWorkflow(
  assignments: WorkerAssignment[],
  context: OrchestrationContext,
  llmConfig: { provider: LLMProvider; model: string },
  llmGetters: LlmGetters,
): Promise<WorkflowResult> {
  const groups = topologicalGroups(assignments);

  const allResults: Array<{ subTaskId: string; output: string; agentId: string }> = [];
  const usedAgentIds = new Set<string>();

  for (const group of groups) {
    // Execute group in parallel
    const groupResults = await Promise.all(
      group.map(a => {
        usedAgentIds.add(a.agent.id);
        return executeWorkerTask(a, context, llmConfig, llmGetters);
      }),
    );
    // Record routing successes for future matching
    for (const a of group) {
      recordRoutingSuccess(a.subTask.requiredSkill, a.agent.id);
    }
    allResults.push(...groupResults);
  }

  // Aggregate results
  const aggregatedOutput = aggregateResults(allResults, assignments);

  // Crystallize workflow result as a growth memory for future reuse
  try {
    const usedAgentIdsArr = Array.from(usedAgentIds);
    const mem = addMemory({
      userId: context.userId,
      type: 'knowledge',
      content: `[Orchestrated Workflow] ${aggregatedOutput.slice(0, 400)}`,
      keywords: ['orchestrated', 'workflow', ...assignments.map(a => a.subTask.requiredSkill)],
      confidence: 0.75,
      sourceInteractionId: `orch_${Date.now()}`,
    }, {
      tier: 'growth',
      perspective: 'lumi_growth',
      importance: 0.7,
    });
    // Mark for cross-agent sharing so other agents can learn from this workflow
    mem.crossAgentShare = true;
    mem.sharedToAgentIds = usedAgentIdsArr;
  } catch (err) {
    // Non-critical — workflow succeeded even if crystallization fails
  }

  return {
    subTaskResults: allResults,
    aggregatedOutput,
    totalAgentsUsed: usedAgentIds.size,
  };
}

// ── Result aggregation ──

const AGGREGATE_PROMPT = `You are Lumi, the master orchestrator. Synthesize the following worker outputs into a single, coherent response for the user.

Original task: {task}

Worker outputs:
{workerOutputs}

Synthesize these results. Fill in gaps. Resolve contradictions. Output the final answer directly — no meta-commentary about workers or aggregation.`;

function aggregateResults(
  results: Array<{ subTaskId: string; output: string; agentId: string }>,
  assignments: WorkerAssignment[],
): string {
  if (results.length === 0) return 'No results produced.';
  if (results.length === 1) return results[0].output;

  // For now, concatenate with clear separation. LLM aggregation happens in the chat pipeline.
  return results
    .map((r, i) => {
      const subTask = assignments.find(a => a.subTask.id === r.subTaskId)?.subTask;
      return `### ${subTask?.description?.slice(0, 60) || r.subTaskId}\n${r.output}`;
    })
    .join('\n\n');
}

/**
 * Full LLM aggregation — call this from the chat pipeline after executeWorkflow.
 */
export async function aggregateWithLLM(
  workflowResult: WorkflowResult,
  originalTask: string,
  llmConfig: { provider: LLMProvider; model: string },
  llmGetters: LlmGetters,
): Promise<string> {
  const workerOutputs = workflowResult.subTaskResults
    .map(r => `[${r.subTaskId}] ${r.output}`)
    .join('\n\n---\n\n');

  const prompt = AGGREGATE_PROMPT
    .replace('{task}', originalTask)
    .replace('{workerOutputs}', workerOutputs);

  try {
    const messages: NormalizedMessage[] = [{ role: 'user', content: prompt }];
    const result = await makeLLMCall(
      messages,
      [],
      { provider: llmConfig.provider, model: llmConfig.model, maxTokens: 2000 },
      llmGetters.getDeepSeek,
      llmGetters.getGemini,
      llmGetters.getOpenAI,
      llmGetters.getAnthropic,
      llmGetters.getQwen,
    );
    return result.text.trim();
  } catch (err) {
    console.error('[Orchestrator] LLM aggregation failed:', err);
    return workflowResult.aggregatedOutput;
  }
}

// ── Skill distillation ──

interface WorkflowPattern {
  taskPrefix: string;
  subTaskCount: number;
  skillTags: string[];
  timestamp: string;
}

/** In-memory store of recent workflow patterns for distillation heuristics */
const recentPatterns: WorkflowPattern[] = [];

/**
 * After a complex workflow completes, record it to the worklog for pattern detection
 * and check if the pattern is reusable (≥ 2 times in 7 days = candidate for skill generation).
 */
export function recordWorkflowPattern(
  task: string,
  subTaskCount: number,
  skillTags: string[],
  userId?: string,
): void {
  // Feed the worklog-based skill distillation pipeline
  if (userId && subTaskCount >= 2) {
    try {
      recordWorkflow({
        userId,
        userIntent: task.slice(0, 120),
        toolSequence: skillTags.map(tag => ({
          name: `orchestrator_${tag}`,
          args: { skillTag: tag },
          resultSummary: `Worker executed ${tag} sub-task`,
        })),
        conversationExcerpt: task.slice(0, 200),
      });
    } catch (err) {
      // Worklog recording is non-critical
    }
  }

  const prefix = task.slice(0, 80).toLowerCase();
  recentPatterns.push({
    taskPrefix: prefix,
    subTaskCount,
    skillTags,
    timestamp: new Date().toISOString(),
  });

  // Keep only last 30 days
  const cutoff = Date.now() - 30 * 86400000;
  while (recentPatterns.length > 0 && new Date(recentPatterns[0].timestamp).getTime() < cutoff) {
    recentPatterns.shift();
  }

  // Cap at 100 entries
  while (recentPatterns.length > 100) {
    recentPatterns.shift();
  }
}

/**
 * Check if the current task pattern has been seen recently.
 * Returns true if the same pattern appeared ≥ 2 times in the last 7 days.
 */
export function shouldDistillSkill(task: string): boolean {
  const prefix = task.slice(0, 80).toLowerCase();
  const sevenDaysAgo = Date.now() - 7 * 86400000;

  const similarPatterns = recentPatterns.filter(
    p => p.taskPrefix === prefix && new Date(p.timestamp).getTime() > sevenDaysAgo,
  );

  return similarPatterns.length >= 2;
}

/**
 * Build a skill description suitable for passing to autoGenerateSkill().
 */
export function buildSkillDescription(
  task: string,
  workflowResult: WorkflowResult,
): string {
  const subTaskDescriptions = workflowResult.subTaskResults
    .map(r => `- ${r.subTaskId}: ${r.output.slice(0, 100)}`)
    .join('\n');

  return [
    `Auto-generated skill for recurring task pattern.`,
    `Task: ${task}`,
    `Sub-tasks (${workflowResult.totalAgentsUsed} agents used):`,
    subTaskDescriptions,
    `\nThis skill automates the full workflow. Input: task description. Output: aggregated result.`,
  ].join('\n');
}
