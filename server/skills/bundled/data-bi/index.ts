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

const server = new McpServer({ name: 'data-bi', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('csv_excel_cleaning_plan', {
  description: 'Create a cleaning plan for CSV/Excel data with column checks, missing values, duplicates, joins, and validation tests.',
  inputSchema: {
    dataDescription: z.string().describe('Column list, sample rows, or data problem description'),
    analysisGoal: z.string().optional().describe('Analysis or reporting goal'),
  },
}, async (args: any) => {
  const cols = list(args.dataDescription).filter(line => /,|\t|列|column|字段/i.test(line)).slice(0, 20);
  return ok({
    analysisGoal: args.analysisGoal || 'TBD',
    detectedColumnHints: cols,
    cleaningSteps: ['Normalize column names', 'Check data types', 'Handle missing values', 'Remove duplicates', 'Validate keys before joins', 'Standardize dates/currency/categories', 'Create audit counts before/after'],
    qualityChecks: ['Row count unchanged unless expected', 'Primary key uniqueness', 'No impossible negative values', 'Date range sane', 'Category mapping reviewed'],
    outputTables: ['cleaned_base_table', 'data_quality_report', 'analysis_ready_view'],
  });
});

server.registerTool('metric_definition_builder', {
  description: 'Define business metrics with numerator, denominator, filters, dimensions, caveats, and owner.',
  inputSchema: {
    metricText: z.string().describe('Metric names or reporting requirements'),
    businessContext: z.string().optional().describe('Business context'),
  },
}, async (args: any) => {
  const metrics = list(args.metricText);
  return ok({
    businessContext: args.businessContext || 'TBD',
    metricDefinitions: metrics.map(metric => ({
      metric,
      numerator: 'TBD',
      denominator: 'TBD if rate metric',
      filters: ['date range', 'business line/channel', 'valid status only'],
      dimensions: ['time', 'channel', 'product/customer segment', 'region/owner'],
      caveats: ['Confirm source table and status mapping', 'Separate gross vs net definitions', 'Document timezone and currency rules'],
    })),
    governance: ['Metric owner', 'Source system', 'Refresh cadence', 'Change log'],
  });
});

server.registerTool('dashboard_brief', {
  description: 'Create a dashboard brief with users, questions, charts, filters, and alert rules.',
  inputSchema: {
    dashboardGoal: z.string().describe('Dashboard goal and audience'),
    metrics: z.union([z.string(), z.array(z.string())]).optional().describe('Metrics to show'),
  },
}, async (args: any) => {
  const metrics = list(args.metrics || '');
  return ok({
    audienceAndGoal: args.dashboardGoal,
    questionsAnswered: ['What changed?', 'Where is the issue/opportunity?', 'Who owns the action?', 'Is it getting better or worse?'],
    sections: [
      { name: 'Overview', charts: ['KPI cards', 'trend line'] },
      { name: 'Breakdown', charts: ['bar by channel/segment', 'table with owner'] },
      { name: 'Exceptions', charts: ['alert table', 'top movers'] },
    ],
    metrics,
    filters: ['Date range', 'Channel', 'Region/team', 'Product/category', 'Customer segment'],
    alertRules: ['Large week-over-week change', 'Below target threshold', 'Missing data or stale refresh'],
  });
});

server.registerTool('anomaly_explainer', {
  description: 'Turn anomaly notes or metric changes into hypotheses, checks, and stakeholder explanation.',
  inputSchema: {
    anomalyText: z.string().describe('Metric anomaly, chart observation, or data issue'),
    metric: z.string().optional().describe('Metric name'),
  },
}, async (args: any) => {
  const text = String(args.anomalyText || '');
  return ok({
    metric: args.metric || 'TBD',
    likelyHypotheses: [
      /campaign|投放|promotion|促销/i.test(text) ? 'Campaign/promotion effect' : 'Demand or mix change',
      /refund|退|售后/i.test(text) ? 'Refund/after-sales impact' : 'Operational status mapping change',
      /data|埋点|口径|tracking/i.test(text) ? 'Data collection/definition issue' : 'Seasonality or one-off event',
    ],
    checks: ['Compare source row counts', 'Break down by channel/product/customer', 'Check data refresh and status mapping', 'Compare with external events', 'Validate against finance/ops source'],
    explanationDraft: 'The metric moved noticeably. We should separate business movement from data-quality issues by checking source counts, segment breakdowns, and recent operational changes.',
  });
});

server.registerTool('weekly_monthly_report_outline', {
  description: 'Build a weekly/monthly business report outline from metrics, notes, wins, risks, and next actions.',
  inputSchema: {
    reportNotes: z.string().describe('Metric notes, business updates, or raw report bullets'),
    period: z.string().optional().describe('Report period'),
  },
}, async (args: any) => {
  const notes = list(args.reportNotes);
  return ok({
    period: args.period || 'TBD',
    outline: ['Executive summary', 'KPI changes', 'Drivers and anomalies', 'Channel/product/customer breakdown', 'Risks', 'Actions and owners', 'Next-period focus'],
    wins: notes.filter(n => /增长|提升|完成|win|increase|better/i.test(n)),
    risks: notes.filter(n => /下降|风险|延期|异常|drop|risk|delay|issue/i.test(n)),
    actionTable: notes.filter(n => /todo|action|跟进|负责|owner/i.test(n)).map(n => ({ action: n, owner: 'TBD', due: 'TBD' })),
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
