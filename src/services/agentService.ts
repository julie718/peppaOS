// Agent service — CRUD operations via REST API + AI call wrapper

import type { Agent, AgentCreateRequest, AgentUpdateRequest, AgentHistoryMessage } from '@/types/api';
import { callAI } from './aiService';

export interface AgentResponse {
  text: string;
  actions?: string[];
  capabilities: string[];
}

export interface AIConfig {
  provider: string;
  model: string;
  apiKey?: string;
}

// ── REST CRUD ──

export async function createAgent(data: AgentCreateRequest): Promise<Agent> {
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to create agent: ${res.status}`);
  return res.json();
}

export async function listAgents(): Promise<Agent[]> {
  const res = await fetch('/api/agents');
  if (!res.ok) throw new Error(`Failed to list agents: ${res.status}`);
  return res.json();
}

export async function updateAgent(id: string, updates: AgentUpdateRequest): Promise<Agent> {
  const res = await fetch(`/api/agents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update agent: ${res.status}`);
  return res.json();
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete agent: ${res.status}`);
}

export async function getAgentHistory(agentId: string): Promise<AgentHistoryMessage[]> {
  const res = await fetch(`/api/agents/${agentId}/history`);
  if (!res.ok) throw new Error(`Failed to get agent history: ${res.status}`);
  return res.json();
}

export async function getSanctuaries(): Promise<any> {
  const res = await fetch('/api/agents/sanctuaries');
  if (!res.ok) throw new Error(`Failed to fetch sanctuaries: ${res.status}`);
  return res.json();
}

// ── AI call wrapper ──

export async function runAgentLogic(
  prompt: string,
  context: { platform: string; aiConfig?: AIConfig },
): Promise<AgentResponse> {
  const { provider = 'gemini', model = 'gemini-1.5-flash', apiKey } = context.aiConfig || {};

  const systemInstruction = `
    You are the PeppaAI Core acting on the ${context.platform} platform.
    If platform is 'electron', you have access to local file systems and system automation.
    If platform is 'web', you are a lightweight assistant restricted to a browser sandbox.

    Respond in a technical, futuristic, and helpful tone.
  `;

  try {
    const response = await callAI(provider, model, prompt, [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: prompt },
    ], apiKey);

    if (response.error) throw new Error(response.error);

    return {
      text: response.text,
      capabilities: context.platform === 'electron'
        ? ['File System', 'System Automation', 'P2P Sync', 'Neural Core']
        : ['Cloud Sync', 'Web Perception'],
      actions: context.platform === 'electron' ? ['AUTO_INDEX_FILES', 'NOTIFY_SYSTEM'] : ['SYNC_CLOUD'],
    };
  } catch (error: any) {
    console.error('Agent Error:', error);
    return {
      text: `Communication Failure: ${error.message}. Fallback to local mesh active.`,
      capabilities: ['Local Safe-mode'],
      actions: [],
    };
  }
}
