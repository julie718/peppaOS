import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  analyzeArApAging,
  buildFinanceReportOutline,
  buildEcommerceTaxWorkpaper,
  buildTaxChecklist,
  estimateTaxPosition,
  forecastCashflow,
  reviewVatInvoices,
  summarizeExpenses,
} from './logic';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'finance-office', version: '1.2.0' }, { capabilities: { tools: {} } });

server.registerTool('expense_summary', {
  description: 'Summarize expense lines into totals, categories, anomalies, and reimbursement review notes. Input can be pasted from receipts or a spreadsheet.',
  inputSchema: {
    expenseText: z.string().describe('Expense lines, one per line. Include amount and short description.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(summarizeExpenses(args)));

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
}, async (args: any) => ok(forecastCashflow(args)));

server.registerTool('finance_report_outline', {
  description: 'Generate a management finance report outline from period, business type, and raw data summary.',
  inputSchema: {
    period: z.string().describe('Reporting period'),
    businessType: z.string().optional().describe('Company or project type'),
    dataSummary: z.string().describe('Known revenue, cost, cash, receivable, payable, or KPI summary'),
  },
}, async (args: any) => ok(buildFinanceReportOutline(args)));

server.registerTool('vat_invoice_review', {
  description: 'Review pasted invoice lines for gross/net/VAT totals, missing rates, negative invoices, and duplicate invoice/amount signals.',
  inputSchema: {
    invoiceText: z.string().describe('Invoice lines. Include invoice number/vendor/description, amount, and tax rate when known.'),
    currency: z.string().optional().describe('Currency code or symbol'),
    defaultVatRate: z.number().optional().describe('Optional default VAT/tax rate. Accepts 0.13 or 13 for 13%.'),
    amountIncludesVat: z.boolean().optional().describe('Whether amounts are tax-inclusive. Defaults to true.'),
  },
}, async (args: any) => ok(reviewVatInvoices(args)));

server.registerTool('tax_period_checklist', {
  description: 'Create a period tax workpaper checklist for finance teams, including source-data close, invoice checks, filing evidence, and risk flags. This is not final tax advice.',
  inputSchema: {
    period: z.string().describe('Reporting or filing period'),
    jurisdiction: z.string().optional().describe('Jurisdiction or country/region code, e.g. CN, US-CA, EU-DE'),
    taxpayerType: z.string().optional().describe('Taxpayer status, e.g. small-scale VAT taxpayer, general taxpayer, sole proprietor, company'),
    businessType: z.string().optional().describe('Business model or industry'),
    taxes: z.union([z.string(), z.array(z.string())]).optional().describe('Known tax types to include'),
    hasPayroll: z.boolean().optional().describe('Whether payroll exists in this period'),
    hasCrossBorder: z.boolean().optional().describe('Whether cross-border trade, services, or payments exist'),
    hasMarketplaceIncome: z.boolean().optional().describe('Whether marketplace/e-commerce platform income exists'),
    dueDate: z.string().optional().describe('Known filing due date if already confirmed'),
  },
}, async (args: any) => ok(buildTaxChecklist(args)));

server.registerTool('tax_position_estimator', {
  description: 'Estimate a management-view tax position from revenue, deductible costs/expenses, VAT output/input tax, and user-provided tax rates. For scenario planning only.',
  inputSchema: {
    revenue: z.number().describe('Revenue or taxable turnover for the period'),
    deductibleCost: z.number().optional().describe('Deductible direct cost'),
    deductibleExpense: z.number().optional().describe('Deductible operating expense'),
    nonDeductibleExpense: z.number().optional().describe('Expenses to add back for taxable profit estimation'),
    taxAdjustmentsDecrease: z.number().optional().describe('Adjustments that reduce taxable profit'),
    vatOutputTax: z.number().optional().describe('Output VAT/tax amount'),
    vatInputTax: z.number().optional().describe('Creditable input VAT/tax amount'),
    incomeTaxRate: z.number().optional().describe('User-provided income tax rate. Accepts 0.25 or 25 for 25%.'),
    surchargeRate: z.number().optional().describe('User-provided surcharge rate on VAT/tax payable. Accepts 0.12 or 12 for 12%.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(estimateTaxPosition(args)));

server.registerTool('ar_ap_aging', {
  description: 'Build an accounts receivable/payable aging table from pasted ledger lines with amounts and due dates, including overdue buckets and risk flags.',
  inputSchema: {
    ledgerText: z.string().describe('Ledger lines. Example: Customer A 3000 due 2026-05-10; Supplier B 1200 2026-07-01.'),
    asOfDate: z.string().optional().describe('Aging date in YYYY-MM-DD format. Defaults to today.'),
    type: z.enum(['receivable', 'payable']).optional().describe('Ledger type. Defaults to receivable.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(analyzeArApAging(args)));

server.registerTool('ecommerce_tax_workpaper', {
  description: 'Create an e-commerce tax workpaper bridge from platform revenue/refunds/fees/ads/freight to invoices, VAT, evidence, and risk flags.',
  inputSchema: {
    period: z.string().describe('Reporting or tax period'),
    platform: z.string().optional().describe('Marketplace or store platform'),
    settlementText: z.string().optional().describe('Optional pasted settlement lines used when explicit amounts are not provided'),
    orderRevenue: z.number().optional().describe('Gross order/platform revenue for the period'),
    refunds: z.number().optional().describe('Refunds/returns for the period'),
    platformFees: z.number().optional().describe('Platform commissions or service fees'),
    adSpend: z.number().optional().describe('Platform advertising spend'),
    freight: z.number().optional().describe('Freight/logistics cost'),
    cogs: z.number().optional().describe('Cost of goods sold'),
    invoiceIssuedAmount: z.number().optional().describe('Invoice amount issued for taxable platform revenue'),
    vatOutputTax: z.number().optional().describe('Output VAT/tax amount'),
    vatInputTax: z.number().optional().describe('Creditable input VAT/tax amount'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(buildEcommerceTaxWorkpaper(args)));

const transport = new StdioServerTransport();
await server.connect(transport);
