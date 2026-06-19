import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function parseLines(text: string): Array<{ label: string; amount: number }> {
  return String(text || '').split(/\n|;/).map(line => {
    const amount = Number((line.match(/-?\d+(?:\.\d+)?/) || ['0'])[0]);
    const label = line.replace(/-?\d+(?:\.\d+)?/, '').trim() || 'item';
    return { label, amount };
  }).filter(item => item.amount !== 0 || item.label !== 'item');
}

const server = new McpServer({ name: 'finance-office', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('expense_summary', {
  description: 'Summarize expense lines into totals, categories, anomalies, and reimbursement review notes. Input can be pasted from receipts or a spreadsheet.',
  inputSchema: {
    expenseText: z.string().describe('Expense lines, one per line. Include amount and short description.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => {
  const items = parseLines(String(args.expenseText || ''));
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  return ok({
    currency: args.currency || 'CNY',
    itemCount: items.length,
    total: Math.round(total * 100) / 100,
    items,
    anomalies: items.filter(item => Math.abs(item.amount) > Math.max(Math.abs(total) * 0.5, 10000)),
    reviewNotes: [
      'Match each expense to invoice/receipt and approval policy.',
      'Check duplicates by date, vendor, amount, and payer.',
      'Separate reimbursable, non-reimbursable, tax-deductible, and project-specific costs.',
    ],
  });
});

server.registerTool('cashflow_forecast', {
  description: 'Create a simple cash-flow forecast from opening cash, receivables, payables, recurring income, and recurring expenses.',
  inputSchema: {
    openingCash: z.number().describe('Starting cash balance'),
    receivables: z.number().optional().describe('Expected incoming cash'),
    payables: z.number().optional().describe('Expected outgoing payables'),
    monthlyIncome: z.number().optional().describe('Recurring monthly income'),
    monthlyExpense: z.number().optional().describe('Recurring monthly expense'),
    months: z.number().optional().describe('Number of months to forecast, default 3'),
  },
}, async (args: any) => {
  const months = Math.min(Math.max(Number(args.months || 3), 1), 24);
  let cash = Number(args.openingCash || 0) + Number(args.receivables || 0) - Number(args.payables || 0);
  const rows = [];
  for (let i = 1; i <= months; i++) {
    cash += Number(args.monthlyIncome || 0) - Number(args.monthlyExpense || 0);
    rows.push({ month: i, projectedCash: Math.round(cash * 100) / 100 });
  }
  return ok({
    openingCash: args.openingCash,
    receivables: args.receivables || 0,
    payables: args.payables || 0,
    forecast: rows,
    riskFlags: rows.filter(row => row.projectedCash < 0).map(row => `Month ${row.month} projected cash is negative.`),
  });
});

server.registerTool('finance_report_outline', {
  description: 'Generate a management finance report outline from period, business type, and raw data summary.',
  inputSchema: {
    period: z.string().describe('Reporting period'),
    businessType: z.string().optional().describe('Company or project type'),
    dataSummary: z.string().describe('Known revenue, cost, cash, receivable, payable, or KPI summary'),
  },
}, async (args: any) => ok({
  period: args.period,
  businessType: args.businessType || 'general business',
  sections: [
    'Executive summary',
    'Revenue and gross margin',
    'Cost and expense movement',
    'Cash-flow and runway',
    'Receivables and payables',
    'Budget variance',
    'Risks and next actions',
  ],
  dataSummary: args.dataSummary,
  checks: [
    'Reconcile totals to source ledger or spreadsheet.',
    'Explain large month-over-month changes.',
    'Separate cash-flow facts from profit/loss facts.',
    'Have finance/accounting staff review before external use.',
  ],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
