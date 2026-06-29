export interface AmountLine {
  label: string;
  amount: number;
}

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toRate(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = Number(String(value).replace('%', '').trim());
  if (!Number.isFinite(raw)) return null;
  return raw > 1 ? raw / 100 : raw;
}

function splitList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

export function parseLines(text: string): AmountLine[] {
  return String(text || '').split(/\n|;/).map(line => {
    const amount = Number((line.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/) || ['0'])[0].replace(/,/g, ''));
    const label = line.replace(/-?\d+(?:,\d{3})*(?:\.\d+)?/, '').trim() || 'item';
    return { label, amount };
  }).filter(item => item.amount !== 0 || item.label !== 'item');
}

export function summarizeExpenses(args: {
  expenseText?: string;
  currency?: string;
}) {
  const items = parseLines(String(args.expenseText || ''));
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  return {
    currency: args.currency || 'CNY',
    itemCount: items.length,
    total: roundMoney(total),
    items,
    anomalies: items.filter(item => Math.abs(item.amount) > Math.max(Math.abs(total) * 0.5, 10000)),
    reviewNotes: [
      'Match each expense to invoice/receipt and approval policy.',
      'Check duplicates by date, vendor, amount, and payer.',
      'Separate reimbursable, non-reimbursable, tax-deductible, and project-specific costs.',
    ],
  };
}

export function forecastCashflow(args: {
  openingCash?: number;
  receivables?: number;
  payables?: number;
  monthlyIncome?: number;
  monthlyExpense?: number;
  months?: number;
}) {
  const months = Math.min(Math.max(Number(args.months || 3), 1), 24);
  let cash = toNumber(args.openingCash) + toNumber(args.receivables) - toNumber(args.payables);
  const rows = [];
  for (let i = 1; i <= months; i++) {
    cash += toNumber(args.monthlyIncome) - toNumber(args.monthlyExpense);
    rows.push({ month: i, projectedCash: roundMoney(cash) });
  }
  return {
    openingCash: toNumber(args.openingCash),
    receivables: toNumber(args.receivables),
    payables: toNumber(args.payables),
    forecast: rows,
    riskFlags: rows.filter(row => row.projectedCash < 0).map(row => `Month ${row.month} projected cash is negative.`),
  };
}

export function buildFinanceReportOutline(args: {
  period?: string;
  businessType?: string;
  dataSummary?: string;
}) {
  return {
    period: args.period,
    businessType: args.businessType || 'general business',
    sections: [
      'Executive summary',
      'Revenue and gross margin',
      'Cost and expense movement',
      'Cash-flow and runway',
      'Receivables and payables',
      'Tax position and invoice status',
      'Budget variance',
      'Risks and next actions',
    ],
    dataSummary: args.dataSummary,
    checks: [
      'Reconcile totals to source ledger or spreadsheet.',
      'Explain large month-over-month changes.',
      'Separate cash-flow facts from profit/loss facts.',
      'Tie tax and invoice summaries back to source documents.',
      'Have finance/accounting staff review before external use.',
    ],
  };
}

function extractInvoiceNo(line: string, fallback: string): string {
  const match = line.match(/(?:invoice|inv|发票|票号|号码|number|no\.?)\s*[:#：-]?\s*([A-Za-z0-9-]{4,})/i);
  return match?.[1] || fallback;
}

function extractPercent(line: string, fallbackRate: number | null): number | null {
  const percent = line.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percent) return toRate(percent[1]);
  return fallbackRate;
}

function extractAmount(line: string): number {
  const matches = Array.from(line.matchAll(/(?<![A-Za-z0-9-])-?\d+(?:,\d{3})*(?:\.\d+)?(?![A-Za-z0-9-]|\s*%)/g)).map(m => Number(m[0].replace(/,/g, '')));
  return matches.length > 0 ? matches[matches.length - 1] : 0;
}

export function reviewVatInvoices(args: {
  invoiceText?: string;
  currency?: string;
  defaultVatRate?: number;
  amountIncludesVat?: boolean;
}) {
  const fallbackRate = toRate(args.defaultVatRate);
  const amountIncludesVat = args.amountIncludesVat !== false;
  const lines = String(args.invoiceText || '').split(/\n|;/).map(s => s.trim()).filter(Boolean);
  const seen = new Map<string, number>();
  const rows = lines.map((line, idx) => {
    const amount = extractAmount(line);
    const vatRate = extractPercent(line, fallbackRate);
    const tax = vatRate === null ? 0 : (amountIncludesVat ? amount * vatRate / (1 + vatRate) : amount * vatRate);
    const netAmount = amountIncludesVat ? amount - tax : amount;
    const invoiceNo = extractInvoiceNo(line, `line-${idx + 1}`);
    const duplicateKey = `${invoiceNo}|${roundMoney(amount)}`;
    seen.set(duplicateKey, (seen.get(duplicateKey) || 0) + 1);
    return {
      lineNo: idx + 1,
      invoiceNo,
      description: line,
      amount: roundMoney(amount),
      vatRate,
      netAmount: roundMoney(netAmount),
      vatAmount: roundMoney(tax),
      amountIncludesVat,
    };
  });

  const totalsByRate = rows.reduce<Record<string, { amount: number; netAmount: number; vatAmount: number; count: number }>>((acc, row) => {
    const key = row.vatRate === null ? 'missing_rate' : `${roundMoney(row.vatRate * 100)}%`;
    acc[key] = acc[key] || { amount: 0, netAmount: 0, vatAmount: 0, count: 0 };
    acc[key].amount += row.amount;
    acc[key].netAmount += row.netAmount;
    acc[key].vatAmount += row.vatAmount;
    acc[key].count += 1;
    return acc;
  }, {});

  for (const total of Object.values(totalsByRate)) {
    total.amount = roundMoney(total.amount);
    total.netAmount = roundMoney(total.netAmount);
    total.vatAmount = roundMoney(total.vatAmount);
  }

  const issues = [
    ...rows.filter(row => row.amount === 0).map(row => `Line ${row.lineNo} has no recognizable amount.`),
    ...rows.filter(row => row.vatRate === null).map(row => `Line ${row.lineNo} has no VAT/tax rate.`),
    ...rows.filter(row => row.amount < 0).map(row => `Line ${row.lineNo} is negative; confirm if it is a refund or red-letter invoice.`),
    ...Array.from(seen.entries()).filter(([, count]) => count > 1).map(([key]) => `Possible duplicate invoice/amount: ${key}.`),
  ];

  return {
    currency: args.currency || 'CNY',
    invoiceCount: rows.length,
    totals: {
      grossAmount: roundMoney(rows.reduce((sum, row) => sum + row.amount, 0)),
      netAmount: roundMoney(rows.reduce((sum, row) => sum + row.netAmount, 0)),
      vatAmount: roundMoney(rows.reduce((sum, row) => sum + row.vatAmount, 0)),
    },
    totalsByRate,
    rows,
    issues,
    reviewNotes: [
      'Confirm invoice authenticity, buyer/seller names, tax IDs, dates, and business purpose.',
      'Match invoice amounts to contracts, orders, receipts, bank payments, and ledger entries.',
      'Treat this as a reconciliation aid; final tax treatment should be reviewed by a qualified accountant.',
    ],
  };
}

export function buildTaxChecklist(args: {
  period?: string;
  jurisdiction?: string;
  taxpayerType?: string;
  businessType?: string;
  taxes?: string | string[];
  hasPayroll?: boolean;
  hasCrossBorder?: boolean;
  hasMarketplaceIncome?: boolean;
  dueDate?: string;
}) {
  const jurisdiction = args.jurisdiction || 'CN';
  const selectedTaxes = splitList(args.taxes);
  const taxes = selectedTaxes.length > 0 ? selectedTaxes : (
    jurisdiction.toUpperCase().includes('CN')
      ? ['VAT or other indirect taxes if applicable', 'Corporate income tax prepayment or annual settlement', 'Payroll individual income tax if applicable', 'Surcharges and stamp tax if applicable']
      : ['Sales/VAT/GST if applicable', 'Income tax estimate or filing', 'Payroll tax if applicable', 'Local business taxes if applicable']
  );

  const riskFlags = [];
  if (args.hasPayroll) riskFlags.push('Payroll exists: reconcile salaries, social benefits, and individual income tax filings.');
  if (args.hasCrossBorder) riskFlags.push('Cross-border activity exists: review withholding tax, customs, FX, and invoice evidence.');
  if (args.hasMarketplaceIncome) riskFlags.push('Marketplace income exists: reconcile platform statements, refunds, ad spend, service fees, and invoices.');

  return {
    period: args.period || 'current period',
    jurisdiction,
    taxpayerType: args.taxpayerType || 'unspecified',
    businessType: args.businessType || 'general business',
    dueDate: args.dueDate || 'Confirm with the local tax authority or accountant.',
    taxes,
    checklist: [
      'Close source data: sales, refunds, purchases, expenses, payroll, bank, platform statements, and invoices.',
      'Reconcile revenue to contracts/orders/settlement statements and bank receipts.',
      'Reconcile deductible costs and expenses to valid invoices, approval records, and payment evidence.',
      'Check output/input tax, invoice status, negative invoices, and unusual tax-rate lines.',
      'Prepare filing workpapers with assumptions, adjustments, screenshots, and reviewer sign-off.',
      'Archive submitted forms, payment vouchers, and supporting ledgers after filing.',
    ],
    riskFlags,
    boundary: 'Planning aid only. Tax rules and deadlines vary by jurisdiction, taxpayer status, industry, and current policy.',
  };
}

export function estimateTaxPosition(args: {
  revenue?: number;
  deductibleCost?: number;
  deductibleExpense?: number;
  nonDeductibleExpense?: number;
  taxAdjustmentsDecrease?: number;
  vatOutputTax?: number;
  vatInputTax?: number;
  incomeTaxRate?: number;
  surchargeRate?: number;
  currency?: string;
}) {
  const revenue = toNumber(args.revenue);
  const deductibleCost = toNumber(args.deductibleCost);
  const deductibleExpense = toNumber(args.deductibleExpense);
  const accountingProfit = revenue - deductibleCost - deductibleExpense;
  const taxableProfitEstimate = accountingProfit + toNumber(args.nonDeductibleExpense) - toNumber(args.taxAdjustmentsDecrease);
  const incomeTaxRate = toRate(args.incomeTaxRate);
  const surchargeRate = toRate(args.surchargeRate);
  const hasVatInputs = args.vatOutputTax !== undefined || args.vatInputTax !== undefined;
  const vatPayable = hasVatInputs ? Math.max(toNumber(args.vatOutputTax) - toNumber(args.vatInputTax), 0) : null;
  const estimatedIncomeTax = incomeTaxRate === null ? null : Math.max(taxableProfitEstimate, 0) * incomeTaxRate;
  const estimatedSurcharge = surchargeRate === null || vatPayable === null ? null : vatPayable * surchargeRate;
  const cashTaxEstimate = [estimatedIncomeTax, vatPayable, estimatedSurcharge]
    .filter((value): value is number => typeof value === 'number')
    .reduce((sum, value) => sum + value, 0);

  return {
    currency: args.currency || 'CNY',
    revenue: roundMoney(revenue),
    accountingProfit: roundMoney(accountingProfit),
    taxableProfitEstimate: roundMoney(taxableProfitEstimate),
    vatPayable: vatPayable === null ? null : roundMoney(vatPayable),
    estimatedSurcharge: estimatedSurcharge === null ? null : roundMoney(estimatedSurcharge),
    estimatedIncomeTax: estimatedIncomeTax === null ? null : roundMoney(estimatedIncomeTax),
    cashTaxEstimate: roundMoney(cashTaxEstimate),
    assumptions: {
      incomeTaxRate,
      surchargeRate,
      ratesAreUserProvided: true,
    },
    reviewNotes: [
      'Input tax rates and adjustments should come from the company accountant or current local policy.',
      'Non-deductible expenses and tax adjustment decreases require source documentation.',
      'Use this for scenario planning, not as a final tax filing calculation.',
    ],
  };
}

function parseDate(value: string | undefined): Date | null {
  const match = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function findDate(value: string): string | undefined {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
}

function daysBetween(from: Date, to: Date): number {
  const ms = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
    - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.floor(ms / 86400000);
}

function agingBucket(daysOverdue: number): string {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

export function analyzeArApAging(args: {
  ledgerText?: string;
  asOfDate?: string;
  type?: 'receivable' | 'payable';
  currency?: string;
}) {
  const asOf = parseDate(args.asOfDate) || new Date();
  const rows = String(args.ledgerText || '').split(/\n|;/).map((line, index) => {
    const text = line.trim();
    if (!text) return null;
    const dueDateText = findDate(text);
    const dueDate = parseDate(dueDateText);
    const amount = extractAmount(text);
    const daysOverdue = dueDate ? daysBetween(dueDate, asOf) : 0;
    const counterparty = text
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      .replace(/(?<![A-Za-z0-9-])-?\d+(?:,\d{3})*(?:\.\d+)?(?![A-Za-z0-9-]|\s*%)/g, '')
      .replace(/\s+/g, ' ')
      .trim() || `party-${index + 1}`;
    return {
      lineNo: index + 1,
      counterparty,
      dueDate: dueDateText || null,
      amount: roundMoney(amount),
      daysOverdue,
      bucket: dueDate ? agingBucket(daysOverdue) : 'missing_due_date',
    };
  }).filter((row): row is NonNullable<typeof row> => Boolean(row));

  const totalsByBucket = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.bucket] = roundMoney((acc[row.bucket] || 0) + row.amount);
    return acc;
  }, {});

  return {
    type: args.type || 'receivable',
    currency: args.currency || 'CNY',
    asOfDate: asOf.toISOString().slice(0, 10),
    rows,
    totalAmount: roundMoney(rows.reduce((sum, row) => sum + row.amount, 0)),
    totalsByBucket,
    riskFlags: [
      ...rows.filter(row => row.bucket === '90+').map(row => `${row.counterparty}: ${row.amount} is overdue more than 90 days.`),
      ...rows.filter(row => row.bucket === 'missing_due_date').map(row => `${row.counterparty}: missing due date.`),
      ...rows.filter(row => row.amount < 0).map(row => `${row.counterparty}: negative amount; confirm credit note, prepayment, or write-off.`),
    ],
    nextActions: args.type === 'payable'
      ? [
          'Prioritize overdue supplier payments by business continuity, penalties, and cash plan.',
          'Reconcile payable balances to contracts, invoices, goods receipts, and bank payments.',
          'Confirm whether negative payable lines are prepayments or supplier credits.',
        ]
      : [
          'Prioritize 90+ day receivables for collection, impairment review, or legal escalation.',
          'Reconcile receivables to contracts, invoices, delivery/service evidence, and bank receipts.',
          'Confirm whether negative receivable lines are refunds, credit notes, or advances received.',
        ],
  };
}

function sumByLabels(text: string, labels: RegExp[]): number {
  let total = 0;
  for (const line of String(text || '').split(/\n|;/)) {
    if (!labels.some(label => label.test(line))) continue;
    total += extractAmount(line);
  }
  return total;
}

function argOrParsed(value: unknown, parsed: number): number {
  return value === undefined || value === null || value === '' ? parsed : toNumber(value);
}

export function buildEcommerceTaxWorkpaper(args: {
  period?: string;
  platform?: string;
  settlementText?: string;
  orderRevenue?: number;
  refunds?: number;
  platformFees?: number;
  adSpend?: number;
  freight?: number;
  cogs?: number;
  invoiceIssuedAmount?: number;
  vatOutputTax?: number;
  vatInputTax?: number;
  currency?: string;
}) {
  const text = String(args.settlementText || '');
  const orderRevenue = argOrParsed(args.orderRevenue, sumByLabels(text, [/payment|paid|receipt|sales|revenue|gmv|收款|结算收入|货款|成交|销售额/]));
  const refunds = argOrParsed(args.refunds, sumByLabels(text, [/refund|return|退款|退货|售后/]));
  const platformFees = argOrParsed(args.platformFees, sumByLabels(text, [/fee|commission|平台费|佣金|服务费|技术服务/]));
  const adSpend = argOrParsed(args.adSpend, sumByLabels(text, [/\bads?\b|\bad.?spend\b|广告|投流|推广/]));
  const freight = argOrParsed(args.freight, sumByLabels(text, [/shipping|freight|物流|运费|快递/]));
  const cogs = toNumber(args.cogs);
  const invoiceIssuedAmount = toNumber(args.invoiceIssuedAmount);
  const taxableRevenueCandidate = orderRevenue - refunds;
  const platformNetCash = taxableRevenueCandidate - platformFees - adSpend - freight;
  const grossProfitEstimate = taxableRevenueCandidate - cogs - freight - platformFees - adSpend;
  const invoiceGap = invoiceIssuedAmount - taxableRevenueCandidate;
  const vatPayable = args.vatOutputTax === undefined && args.vatInputTax === undefined
    ? null
    : Math.max(toNumber(args.vatOutputTax) - toNumber(args.vatInputTax), 0);
  const materialGap = Math.max(Math.abs(taxableRevenueCandidate) * 0.02, 100);

  return {
    period: args.period || 'current period',
    platform: args.platform || 'marketplace',
    currency: args.currency || 'CNY',
    revenueBridge: {
      orderRevenue: roundMoney(orderRevenue),
      refunds: roundMoney(refunds),
      taxableRevenueCandidate: roundMoney(taxableRevenueCandidate),
      platformFees: roundMoney(platformFees),
      adSpend: roundMoney(adSpend),
      freight: roundMoney(freight),
      platformNetCash: roundMoney(platformNetCash),
      cogs: roundMoney(cogs),
      grossProfitEstimate: roundMoney(grossProfitEstimate),
    },
    invoiceBridge: {
      invoiceIssuedAmount: roundMoney(invoiceIssuedAmount),
      invoiceGap: roundMoney(invoiceGap),
      invoiceCoverageRate: taxableRevenueCandidate > 0 ? roundMoney(invoiceIssuedAmount / taxableRevenueCandidate * 100) : null,
    },
    vatBridge: {
      vatOutputTax: args.vatOutputTax === undefined ? null : roundMoney(toNumber(args.vatOutputTax)),
      vatInputTax: args.vatInputTax === undefined ? null : roundMoney(toNumber(args.vatInputTax)),
      vatPayable: vatPayable === null ? null : roundMoney(vatPayable),
    },
    riskFlags: [
      ...(Math.abs(invoiceGap) > materialGap ? [`Invoice amount differs from taxable revenue candidate by ${roundMoney(invoiceGap)}.`] : []),
      ...(invoiceIssuedAmount === 0 && taxableRevenueCandidate > 0 ? ['No issued invoice amount provided for positive platform revenue.'] : []),
      ...(vatPayable === null ? ['VAT output/input tax not provided; add tax ledger or invoice summary before filing review.'] : []),
      ...(platformFees + adSpend > taxableRevenueCandidate * 0.35 ? ['Platform fees plus ads exceed 35% of revenue; review profitability and deductible evidence.'] : []),
    ],
    evidenceChecklist: [
      'Platform settlement statement and order export for the exact period.',
      'Refund/return export and after-sales evidence.',
      'Ad spend statement, platform service-fee invoice, freight invoice, and payment records.',
      'Issued invoice list, red-letter invoice list, and VAT input invoice summary.',
      'Accounting entries that reconcile platform net cash to bank receipts.',
    ],
    boundary: 'Workpaper aid only. Revenue recognition, invoicing, and tax filing positions must be reviewed by finance/accounting staff.',
  };
}
