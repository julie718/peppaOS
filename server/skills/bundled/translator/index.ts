import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function handler(args: any) {
  const text = String(args.text || '');
  const from = String(args.from || 'auto');
  const to = String(args.to || 'en');
  if (!text.trim()) return { content: [{ type: 'text' as const, text: 'Error: no text provided to translate' }], isError: true };
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data: any = await res.json();
    const translated = data?.[0]?.map((seg: any) => seg[0]).join('') || '(no translation)';
    const result = JSON.stringify({ from, to, original: text.slice(0, 200), translated: translated.slice(0, 2000) }, null, 2);
    return { content: [{ type: 'text' as const, text: result }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Translation failed: ${e.message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'translator', version: '1.0.0' }, { capabilities: { tools: {} } });
server.registerTool('translate', {
  description: 'Translate text between languages. Auto-detects source language by default.',
  inputSchema: {
    text: z.string().describe('Text to translate'),
    from: z.string().optional().describe('Source language (default: auto-detect, e.g. "zh", "en", "ja")'),
    to: z.string().describe('Target language (e.g. "en", "zh", "ja", "ko", "fr", "de")'),
  },
}, handler);

const transport = new StdioServerTransport();
await server.connect(transport);
