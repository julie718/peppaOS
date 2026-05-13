import { readDB, writeDB } from '../../db_layer';

export interface Conversation {
  id: string;
  userId: string;
  agentId: string;
  title: string;
  status: 'active' | 'paused' | 'closed';
  summary: string;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  userId: string;
  agentId?: string;
  conversationId?: string;
  module?: string;
  message: string;
  response?: string;
  role: string;
  personality?: string;
  mode?: string;
  toolCalls?: string;
  timestamp: string;
}

export function getOrCreateActiveConversation(userId: string, agentId?: string): Conversation {
  const db = readDB();
  if (!db.conversations) db.conversations = [];

  const active = db.conversations.find(
    (c: Conversation) => c.userId === userId && c.agentId === agentId && c.status === 'active'
  );
  if (active) return active;

  const id = 'conv_' + crypto.randomUUID();
  const now = new Date().toISOString();
  const conv: Conversation = {
    id,
    userId,
    agentId: agentId || '',
    title: '',
    status: 'active',
    summary: '',
    messageCount: 0,
    lastActiveAt: now,
    createdAt: now,
  };
  db.conversations.push(conv);
  writeDB(db);
  return conv;
}

export function closeConversation(conversationId: string, summary?: string): Conversation | null {
  const db = readDB();
  if (!db.conversations) return null;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return null;
  conv.status = 'closed';
  conv.summary = summary || '';
  conv.lastActiveAt = new Date().toISOString();
  writeDB(db);
  return conv;
}

export function getActiveConversation(userId: string, agentId?: string): Conversation | null {
  const db = readDB();
  if (!db.conversations) return null;
  return db.conversations.find(
    (c: Conversation) => c.userId === userId && (agentId ? c.agentId === agentId : true) && c.status === 'active'
  ) || null;
}

export function getUserConversations(userId: string, limit = 20, offset = 0): Conversation[] {
  const db = readDB();
  if (!db.conversations) return [];
  return db.conversations
    .filter((c: Conversation) => c.userId === userId)
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(offset, offset + limit);
}

export function addMessage(msg: {
  userId: string;
  agentId?: string;
  conversationId?: string;
  role: string;
  content: string;
  response?: string;
  personality?: string;
  mode?: string;
  toolCalls?: any;
}): string {
  const db = readDB();
  const id = 'msg_' + crypto.randomUUID();
  const now = new Date().toISOString();

  const interaction: any = {
    id,
    userId: msg.userId,
    agentId: msg.agentId || '',
    conversationId: msg.conversationId || '',
    module: msg.personality || '',
    message: msg.content,
    response: msg.response || '',
    role: msg.role,
    personality: msg.personality || '',
    mode: msg.mode || '',
    toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : '',
    timestamp: now,
  };

  if (!db.interactions) db.interactions = [];
  db.interactions.push(interaction);

  // Update conversation messageCount and lastActiveAt
  if (msg.conversationId && db.conversations) {
    const conv = db.conversations.find((c: Conversation) => c.id === msg.conversationId);
    if (conv) {
      conv.messageCount = (conv.messageCount || 0) + 1;
      conv.lastActiveAt = now;
      // Auto-title from first user message
      if (!conv.title && msg.role === 'user' && msg.content?.trim()) {
        conv.title = msg.content.trim().slice(0, 80);
      }
    }
  }

  writeDB(db);
  return id;
}

export function getMessages(conversationId: string, limit = 50): MessageRecord[] {
  const db = readDB();
  if (!db.interactions) return [];
  return db.interactions
    .filter((i: any) => i.conversationId === conversationId)
    .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(-limit);
}

export function getMessagesForAgent(userId: string, agentId: string, limit = 50): MessageRecord[] {
  const conv = getActiveConversation(userId, agentId);
  if (!conv) return [];
  return getMessages(conv.id, limit);
}

/** Messages threshold for auto-summarization */
const AUTO_SUMMARY_THRESHOLD = 20;

/**
 * Check if a conversation needs auto-summarization.
 * Returns the conversation and older messages if threshold exceeded.
 */
export function checkAutoSummary(
  conversationId: string,
): { needed: boolean; conversation: Conversation | null; recentMessages: MessageRecord[] } {
  const db = readDB();
  if (!db.conversations) return { needed: false, conversation: null, recentMessages: [] };
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv || conv.messageCount < AUTO_SUMMARY_THRESHOLD) {
    return { needed: false, conversation: conv || null, recentMessages: [] };
  }
  // Only summarize if last summary was more than 20 messages ago (avoid re-summarizing every message)
  const recentMessages = getMessages(conversationId, 40);
  return { needed: true, conversation: conv, recentMessages };
}

/**
 * Store a conversation summary (replaces existing).
 */
export function setConversationSummary(conversationId: string, summary: string): void {
  const db = readDB();
  if (!db.conversations) return;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return;
  conv.summary = summary;
  writeDB(db);
}

export function getUnclosedConversation(userId: string): Conversation | null {
  const db = readDB();
  if (!db.conversations) return null;
  const convs = db.conversations.filter(
    (c: Conversation) => c.userId === userId && c.status === 'active'
  );
  if (convs.length === 0) return null;
  return convs.reduce((a: Conversation, b: Conversation) =>
    new Date(a.lastActiveAt).getTime() > new Date(b.lastActiveAt).getTime() ? a : b
  );
}
