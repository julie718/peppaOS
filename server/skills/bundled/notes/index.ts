import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';

const NOTES_DIR = process.env.LUMI_DATA_DIR
  ? path.join(process.env.LUMI_DATA_DIR, 'data', 'notes')
  : path.join(os.homedir(), 'peppa_notes');
if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });

function listNotes(): { name: string; size: number; modified: string }[] {
  return fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md')).map(f => {
    const p = path.join(NOTES_DIR, f);
    const stat = fs.statSync(p);
    return { name: f.replace('.md', ''), size: stat.size, modified: stat.mtime.toISOString() };
  });
}

async function createHandler(args: any) {
  const name = String(args.name || '').replace(/[^a-zA-Z0-9_\-一-鿿]/g, '_');
  const content = String(args.content || '');
  if (!name) return { content: [{ type: 'text' as const, text: 'Error: note name is required' }], isError: true };
  const filePath = path.join(NOTES_DIR, `${name}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return { content: [{ type: 'text' as const, text: `Note "${name}" saved (${content.length} chars)` }] };
}

async function readHandler(args: any) {
  const name = String(args.name || '').replace(/[^a-zA-Z0-9_\-一-鿿]/g, '_');
  if (!name) return { content: [{ type: 'text' as const, text: JSON.stringify(listNotes(), null, 2) }] };
  const filePath = path.join(NOTES_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) return { content: [{ type: 'text' as const, text: `Note "${name}" not found. Available: ${listNotes().map(n => n.name).join(', ')}` }], isError: true };
  return { content: [{ type: 'text' as const, text: fs.readFileSync(filePath, 'utf-8').slice(0, 5000) }] };
}

async function listHandler(_args: any) {
  const notes = listNotes();
  if (notes.length === 0) return { content: [{ type: 'text' as const, text: 'No notes yet. Create one!' }] };
  return { content: [{ type: 'text' as const, text: JSON.stringify(notes, null, 2) }] };
}

async function deleteHandler(args: any) {
  const name = String(args.name || '').replace(/[^a-zA-Z0-9_\-一-鿿]/g, '_');
  if (!name) return { content: [{ type: 'text' as const, text: 'Error: note name is required' }], isError: true };
  const filePath = path.join(NOTES_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) return { content: [{ type: 'text' as const, text: `Note "${name}" not found` }], isError: true };
  fs.unlinkSync(filePath);
  return { content: [{ type: 'text' as const, text: `Note "${name}" deleted` }] };
}

const server = new McpServer({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('create_note', {
  description: 'Create a new note or overwrite an existing one. Notes are stored as markdown files.',
  inputSchema: {
    name: z.string().describe('Note name (used as filename)'),
    content: z.string().describe('Note content (markdown supported)'),
  },
}, createHandler);

server.registerTool('read_note', {
  description: 'Read a note by name. If no name given, lists all notes.',
  inputSchema: { name: z.string().optional().describe('Note name to read') },
}, readHandler);

server.registerTool('list_notes', {
  description: 'List all saved notes with metadata.',
  inputSchema: {},
}, listHandler);

server.registerTool('delete_note', {
  description: 'Delete a note by name.',
  inputSchema: { name: z.string().describe('Note name to delete') },
}, deleteHandler);

const transport = new StdioServerTransport();
await server.connect(transport);
