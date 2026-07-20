/**
 * Context Stack — maintains a focus stack for multi-turn conversations.
 * Each frame captures the intent and active topic of a user turn.
 * Expired frames (older than 5 minutes) are auto-purged.
 */

interface ContextFrame {
  /** Unique frame ID */
  id: string;
  /** User intent / topic summary */
  intent: string;
  /** When this frame was created (epoch ms) */
  createdAt: number;
  /** How many turns this frame has been active */
  activeTurns: number;
}

const stack: ContextFrame[] = [];
const FRAME_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Push a new context frame onto the stack.
 * @returns The new frame ID
 */
export function pushFrame(intent: string): string {
  const id = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  stack.push({ id, intent, createdAt: Date.now(), activeTurns: 0 });
  cleanExpired();
  return id;
}

/**
 * Pop the most recent frame off the stack.
 * @returns The popped frame, or null if stack is empty
 */
export function popFrame(): ContextFrame | null {
  return stack.pop() || null;
}

/**
 * Get the current context by merging the top 3 active frames.
 * @returns A concatenated intent string for prompt injection
 */
export function getCurrentContext(): string {
  cleanExpired();
  const top = stack.slice(-3);
  if (top.length === 0) return '';
  return top.map(f => f.intent).join(' → ');
}

/**
 * Remove frames older than FRAME_TTL_MS.
 */
export function cleanExpired(): void {
  const now = Date.now();
  for (let i = stack.length - 1; i >= 0; i--) {
    if (now - stack[i].createdAt > FRAME_TTL_MS) {
      stack.splice(i, 1);
    }
  }
}
