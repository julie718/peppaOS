import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function calcHandler(args: any) {
  const expr = String(args.expression || '');
  if (!expr.trim()) return { content: [{ type: 'text' as const, text: 'Error: no expression provided' }], isError: true };
  try {
    const sandboxed = expr.replace(/[^0-9+\-*/().%\s]|Math\./g, '');
    const result = Function(`"use strict"; return (${sandboxed})`)();
    return { content: [{ type: 'text' as const, text: JSON.stringify({ expression: expr, result: String(result) }, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Calculation error: ${e.message}` }], isError: true };
  }
}

async function convertHandler(args: any) {
  const value = Number(args.value);
  const from = String(args.from || '');
  const to = String(args.to || '');
  if (isNaN(value)) return { content: [{ type: 'text' as const, text: 'Error: invalid numeric value' }], isError: true };
  const conversions: Record<string, Record<string, number>> = {
    km: { m: 1000, mile: 0.621371, ft: 3280.84 },
    m: { km: 0.001, cm: 100, ft: 3.28084, inch: 39.3701 },
    mile: { km: 1.60934, m: 1609.34, ft: 5280 },
    kg: { g: 1000, lb: 2.20462, oz: 35.274 },
    g: { kg: 0.001, lb: 0.00220462, oz: 0.035274 },
    lb: { kg: 0.453592, g: 453.592 },
  };
  const c_from = conversions[from.toLowerCase()];
  if (!c_from) return { content: [{ type: 'text' as const, text: `Error: unsupported unit "${from}". Supported: ${Object.keys(conversions).join(', ')}` }], isError: true };
  const factor = c_from[to.toLowerCase()];
  if (!factor) return { content: [{ type: 'text' as const, text: `Error: cannot convert ${from} to ${to}` }], isError: true };
  // Temperature
  if (from.toLowerCase() === 'c' && to.toLowerCase() === 'f') {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ value, from, to, result: Math.round((value * 9/5 + 32) * 1e4) / 1e4 }, null, 2) }] };
  }
  if (from.toLowerCase() === 'f' && to.toLowerCase() === 'c') {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ value, from, to, result: Math.round(((value - 32) * 5/9) * 1e4) / 1e4 }, null, 2) }] };
  }
  if (from.toLowerCase() === 'c' && to.toLowerCase() === 'k') {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ value, from, to, result: Math.round((value + 273.15) * 1e4) / 1e4 }, null, 2) }] };
  }
  if (from.toLowerCase() === 'f' && to.toLowerCase() === 'k') {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ value, from, to, result: Math.round(((value - 32) * 5/9 + 273.15) * 1e4) / 1e4 }, null, 2) }] };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify({ value, from, to, result: Math.round(value * factor * 1e6) / 1e6 }, null, 2) }] };
}

const server = new McpServer({ name: 'calculator', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('calculate', {
  description: 'Evaluate a mathematical expression. Supports +, -, *, /, %, (), and decimals.',
  inputSchema: { expression: z.string().describe('Math expression, e.g. "(15 * 3) / 2.5 + 100"') },
}, calcHandler);

server.registerTool('convert_units', {
  description: 'Convert between units: length (km/m/mile/ft/cm/inch), weight (kg/g/lb/oz), temperature (c/f/k).',
  inputSchema: {
    value: z.number().describe('Numeric value to convert'),
    from: z.string().describe('Source unit (km, m, mile, kg, g, lb, c, f)'),
    to: z.string().describe('Target unit'),
  },
}, convertHandler);

const transport = new StdioServerTransport();
await server.connect(transport);
