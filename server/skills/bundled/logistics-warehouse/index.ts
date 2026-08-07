import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\r?\n|[;；]/).map(s => s.trim()).filter(Boolean);
}

function classify(line: string): string {
  if (/入库|inbound|received|arrival/i.test(line)) return 'inbound';
  if (/出库|outbound|ship|dispatch/i.test(line)) return 'outbound';
  if (/拣货|pick|packing|包装/i.test(line)) return 'picking/packing';
  if (/盘点|count|差异|variance/i.test(line)) return 'inventory count';
  if (/延误|delay|late/i.test(line)) return 'delivery delay';
  return 'general';
}

const server = new McpServer({ name: 'logistics-warehouse', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('inbound_outbound_summary', {
  description: 'Summarize inbound/outbound warehouse lines into movement categories, exceptions, and follow-up checks.',
  inputSchema: {
    movementText: z.string().describe('Inbound/outbound records or warehouse notes'),
    date: z.string().optional().describe('Date'),
  },
}, async (args: any) => {
  const rows = list(args.movementText);
  return ok({
    date: args.date || new Date().toISOString().slice(0, 10),
    movements: rows.map(row => ({ row, type: classify(row), exception: /少|多|破损|missing|damage|wrong|差异/i.test(row) })),
    checks: ['Document/order number', 'SKU/barcode', 'Quantity', 'Batch/lot', 'Location/bin', 'Operator/time', 'Photo/evidence for exceptions'],
    followUp: ['Reconcile system and physical count', 'Escalate damaged/missing items', 'Update customer/order owner if outbound affected'],
  });
});

server.registerTool('picking_exception_triage', {
  description: 'Triage picking/packing exceptions by cause, urgency, and next action.',
  inputSchema: {
    exceptionText: z.string().describe('Picking, packing, SKU mismatch, or warehouse exception notes'),
  },
}, async (args: any) => {
  const rows = list(args.exceptionText);
  return ok({
    exceptions: rows.map(row => ({
      row,
      cause: /缺货|out.?of.?stock|short/i.test(row) ? 'stock shortage' : /错|wrong|mismatch/i.test(row) ? 'SKU mismatch' : /破损|damage/i.test(row) ? 'damage' : 'unknown',
      urgency: /加急|urgent|today|今天/i.test(row) ? 'urgent' : 'normal',
      action: 'Hold shipment, verify SKU/location/count, record evidence, and notify order owner.',
    })),
    preventionChecks: ['Location accuracy', 'Barcode scan rule', 'Substitution approval', 'Packing photo for high-value orders'],
  });
});

server.registerTool('inventory_count_plan', {
  description: 'Create an inventory count plan with sample scope, discrepancy handling, and reconciliation steps.',
  inputSchema: {
    inventoryScope: z.string().describe('Warehouse area, SKU range, or stock notes'),
    countType: z.enum(['cycle', 'full', 'spot']).optional().describe('Count type'),
  },
}, async (args: any) => ok({
  countType: args.countType || 'cycle',
  scope: args.inventoryScope,
  plan: ['Freeze movement window if needed', 'Export system quantity', 'Assign counters', 'Count physical stock', 'Second count for variance', 'Approve adjustment', 'Analyze root cause'],
  varianceRules: ['Recount high-value/large-variance items', 'Check recent inbound/outbound', 'Review damaged/return bins', 'Attach photo/evidence'],
  output: ['Count sheet', 'Variance table', 'Adjustment approval', 'Root-cause notes'],
}));

server.registerTool('delivery_delay_notice', {
  description: 'Create internal and customer-facing delivery delay notices with cause, ETA, and action options.',
  inputSchema: {
    delayText: z.string().describe('Carrier update, delay note, or customer order context'),
    customerName: z.string().optional().describe('Customer name'),
  },
}, async (args: any) => ok({
  causeSignals: list(args.delayText).filter(line => /weather|customs|traffic|carrier|延误|天气|海关|派送/i.test(line)),
  internalAction: ['Confirm latest carrier event', 'Ask for ETA and required action', 'Check replacement/reship option', 'Update order owner'],
  customerNotice: `Hi ${args.customerName || ''}, we are sorry for the delay. The shipment is currently being checked with the carrier. We will update you with the latest ETA and next step as soon as it is confirmed.`,
  evidenceNeeded: ['Tracking screenshot', 'Carrier case number', 'Order id', 'Customer address/contact verification'],
}));

server.registerTool('freight_cost_check', {
  description: 'Review freight charge lines for cost components, anomalies, and reconciliation questions.',
  inputSchema: {
    freightText: z.string().describe('Freight invoice, carrier quote, or logistics cost lines'),
    expectedCost: z.number().optional().describe('Expected cost if known'),
  },
}, async (args: any) => {
  const rows = list(args.freightText);
  return ok({
    expectedCost: args.expectedCost || 'TBD',
    costComponents: rows.filter(row => /freight|fuel|remote|insurance|tax|surcharge|运费|燃油|偏远|保险|税/i.test(row)),
    anomalySignals: rows.filter(row => /adjust|extra|异常|附加|超重|体积重|remote|偏远/i.test(row)),
    reconciliationQuestions: ['Billing weight vs actual/volumetric?', 'Remote area surcharge?', 'Fuel/peak surcharge?', 'Insurance/tax included?', 'Duplicate shipment charge?'],
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
