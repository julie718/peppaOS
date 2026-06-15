import { readDB, writeDB } from '../../db_layer';

export interface AutonomousWorkflow {
  id: string;
  userId: string;
  title: string;
  description: string;
  trigger: string;
  allowedModes: Array<'analysis' | 'desktop' | 'terminal'>;
  allowedActions: string[];
  externalAppsAllowed: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

type WorkflowInput = Partial<Omit<AutonomousWorkflow, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>;

function allWorkflows(): AutonomousWorkflow[] {
  try {
    const db = readDB();
    return Array.isArray(db.autonomousWorkflows) ? db.autonomousWorkflows : [];
  } catch {
    return [];
  }
}

function saveWorkflows(workflows: AutonomousWorkflow[]) {
  const db = readDB();
  db.autonomousWorkflows = workflows;
  writeDB(db);
}

function normalizeModes(value: unknown): Array<'analysis' | 'desktop' | 'terminal'> {
  const modes = Array.isArray(value) ? value : ['analysis'];
  const allowed = new Set(['analysis', 'desktop', 'terminal']);
  const normalized = modes.filter(mode => allowed.has(String(mode))) as Array<'analysis' | 'desktop' | 'terminal'>;
  return normalized.length > 0 ? normalized : ['analysis'];
}

function normalizeActions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

export function listAutonomousWorkflows(userId: string): AutonomousWorkflow[] {
  return allWorkflows().filter(workflow => workflow.userId === userId);
}

export function listEnabledAutonomousWorkflows(userId: string): AutonomousWorkflow[] {
  return listAutonomousWorkflows(userId).filter(workflow => workflow.enabled);
}

export function upsertAutonomousWorkflow(userId: string, input: WorkflowInput & { id?: string }): AutonomousWorkflow {
  const workflows = allWorkflows();
  const now = new Date().toISOString();
  const existingIndex = input.id
    ? workflows.findIndex(workflow => workflow.userId === userId && workflow.id === input.id)
    : -1;
  const existing = existingIndex >= 0 ? workflows[existingIndex] : null;

  const workflow: AutonomousWorkflow = {
    id: existing?.id || `workflow_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId,
    title: String(input.title || existing?.title || 'Untitled workflow').slice(0, 120),
    description: String(input.description || existing?.description || '').slice(0, 1000),
    trigger: String(input.trigger || existing?.trigger || '').slice(0, 500),
    allowedModes: normalizeModes(input.allowedModes || existing?.allowedModes),
    allowedActions: normalizeActions(input.allowedActions || existing?.allowedActions),
    externalAppsAllowed: Boolean(input.externalAppsAllowed ?? existing?.externalAppsAllowed ?? false),
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    workflows[existingIndex] = workflow;
  } else {
    workflows.push(workflow);
  }
  saveWorkflows(workflows);
  return workflow;
}

export function setAutonomousWorkflowEnabled(userId: string, id: string, enabled: boolean): AutonomousWorkflow | null {
  const workflows = allWorkflows();
  const index = workflows.findIndex(workflow => workflow.userId === userId && workflow.id === id);
  if (index < 0) return null;
  workflows[index] = {
    ...workflows[index],
    enabled,
    updatedAt: new Date().toISOString(),
  };
  saveWorkflows(workflows);
  return workflows[index];
}
