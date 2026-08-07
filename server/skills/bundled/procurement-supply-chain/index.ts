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

function riskFlags(text: string): string[] {
  return [
    [/延期|delay|late/i, 'delivery delay'],
    [/涨价|price increase|cost up/i, 'price increase'],
    [/质量|不良|defect|quality/i, 'quality concern'],
    [/独家|single source|sole/i, 'single-source risk'],
    [/预付|deposit|advance/i, 'payment exposure'],
  ].filter(([re]) => (re as RegExp).test(text)).map(([, label]) => label as string);
}

const server = new McpServer({ name: 'procurement-supply-chain', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('supplier_quote_compare', {
  description: 'Compare supplier quote lines and produce evaluation fields, risks, and negotiation questions.',
  inputSchema: {
    quotesText: z.string().describe('Supplier quotes, one supplier per line if possible'),
    criteria: z.union([z.string(), z.array(z.string())]).optional().describe('Comparison criteria'),
  },
}, async (args: any) => {
  const quotes = list(args.quotesText);
  return ok({
    criteria: list(args.criteria).concat(['Price', 'Lead time', 'Quality evidence', 'Payment terms', 'Warranty/after-sales', 'Invoice/tax']),
    suppliers: quotes.map((quote, index) => ({ supplier: `Supplier ${index + 1}`, quote, risks: riskFlags(quote) })),
    negotiationQuestions: ['Can price improve at volume tiers?', 'Can lead time be committed in writing?', 'What quality documents/sample records exist?', 'What is the warranty or replacement rule?'],
  });
});

server.registerTool('purchase_plan_builder', {
  description: 'Create a purchase plan from demand, current inventory, lead time, and safety stock notes.',
  inputSchema: {
    demandText: z.string().describe('Demand forecast, inventory lines, or material request notes'),
    planningWindow: z.string().optional().describe('Planning window'),
  },
}, async (args: any) => {
  const lines = list(args.demandText);
  return ok({
    planningWindow: args.planningWindow || 'TBD',
    purchaseItems: lines.map(line => ({ item: line, action: /缺|short|low|urgent/i.test(line) ? 'buy/expedite' : 'review', risk: riskFlags(line) })),
    planningChecks: ['Demand source', 'Current stock', 'Open PO', 'Lead time', 'MOQ/lot size', 'Safety stock', 'Budget approval'],
    nextActions: ['Confirm demand owner', 'Check existing stock/open PO', 'Ask supplier for delivery slot', 'Prepare approval request'],
  });
});

server.registerTool('delivery_risk_tracker', {
  description: 'Track supplier delivery risk and generate escalation actions and message draft.',
  inputSchema: {
    updateText: z.string().describe('Supplier updates, PO status, or chat logs'),
    requiredDate: z.string().optional().describe('Required delivery date'),
  },
}, async (args: any) => {
  const flags = riskFlags(args.updateText || '');
  return ok({
    requiredDate: args.requiredDate || 'TBD',
    riskLevel: flags.length >= 2 ? 'high' : flags.length ? 'medium' : 'low',
    riskFlags: flags,
    escalationActions: ['Ask for committed ship date', 'Confirm partial shipment', 'Find substitute/backup source', 'Update internal delivery impact', 'Document supplier commitment'],
    supplierMessage: 'Please confirm current production quantity, earliest shipment date, remaining blockers, and whether partial shipment is possible.',
  });
});

server.registerTool('inventory_warning_review', {
  description: 'Review inventory lines for shortage, overstock, dead stock, and replenishment action.',
  inputSchema: {
    inventoryText: z.string().describe('Inventory, daily usage, stock age, or warehouse lines'),
  },
}, async (args: any) => {
  const rows = list(args.inventoryText);
  return ok({
    shortageSignals: rows.filter(row => /缺|low|short|zero|urgent|断货/i.test(row)),
    overstockSignals: rows.filter(row => /overstock|呆滞|积压|slow|age|库龄/i.test(row)),
    reviewFields: ['SKU/material', 'Stock', 'Daily usage', 'Open PO', 'Lead time', 'Safety stock', 'Stock age'],
    actions: ['Expedite shortage items', 'Freeze or discount slow items', 'Reconcile system vs physical count', 'Review demand forecast'],
  });
});

server.registerTool('procurement_contract_checklist', {
  description: 'Build a procurement contract checklist with key clauses, missing data, and risk review questions.',
  inputSchema: {
    contractNotes: z.string().describe('Contract notes, term sheet, or supplier agreement text'),
  },
}, async (args: any) => ok({
  riskFlags: riskFlags(args.contractNotes || ''),
  clauseChecklist: ['Scope/specification', 'Price and tax', 'Delivery and acceptance', 'Quality warranty', 'Payment milestone', 'Liability and penalty', 'Confidentiality/IP', 'Dispute resolution'],
  missingData: ['Supplier legal entity', 'Product/spec/version', 'Delivery location/date', 'Acceptance standard', 'Invoice type', 'Owner for change orders'],
  reviewBoundary: 'This is a procurement checklist, not legal advice. Contracts should be reviewed by accountable business/legal owners.',
}));

const transport = new StdioServerTransport();
await server.connect(transport);
