import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const timers: Map<string, { start: number; duration: number; label: string }> = new Map();

async function setHandler(args: any) {
  const duration = Number(args.duration) || 0;
  const label = String(args.label || 'Timer');
  if (duration <= 0 || duration > 86400) return { content: [{ type: 'text' as const, text: 'Error: duration must be between 1 and 86400 seconds' }], isError: true };
  const id = `${Date.now()}`;
  timers.set(id, { start: Date.now(), duration: duration * 1000, label });
  return { content: [{ type: 'text' as const, text: JSON.stringify({
    message: `Timer set: "${label}" for ${duration}s (${(duration/60).toFixed(1)} min)`,
    timerId: id,
    expiresAt: new Date(Date.now() + duration * 1000).toISOString(),
  }, null, 2) }] };
}

async function listHandler(_args: any) {
  if (timers.size === 0) return { content: [{ type: 'text' as const, text: 'No active timers' }] };
  const now = Date.now();
  const result = Array.from(timers.entries()).map(([id, t]) => {
    const elapsed = now - t.start;
    const remaining = Math.max(0, t.duration - elapsed);
    return { id, label: t.label, total: `${(t.duration/1000).toFixed(0)}s`, remaining: `${(remaining/1000).toFixed(0)}s`, status: remaining <= 0 ? 'DONE' : 'running' };
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

async function cancelHandler(args: any) {
  const id = String(args.timerId || '');
  if (!id || !timers.has(id)) return { content: [{ type: 'text' as const, text: `Timer not found. Active timers: ${timers.size}` }], isError: true };
  const t = timers.get(id)!;
  timers.delete(id);
  return { content: [{ type: 'text' as const, text: `Timer "${t.label}" cancelled` }] };
}

const server = new McpServer({ name: 'timer', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('set_timer', {
  description: 'Set a countdown timer. Returns a timer ID for checking/cancelling.',
  inputSchema: {
    duration: z.number().describe('Duration in seconds (max 86400 = 24h)'),
    label: z.string().optional().describe('Label for the timer'),
  },
}, setHandler);

server.registerTool('list_timers', {
  description: 'List all active timers with remaining time.',
  inputSchema: {},
}, listHandler);

server.registerTool('cancel_timer', {
  description: 'Cancel a timer by its ID.',
  inputSchema: { timerId: z.string().describe('Timer ID from set_timer result') },
}, cancelHandler);

const transport = new StdioServerTransport();
await server.connect(transport);
