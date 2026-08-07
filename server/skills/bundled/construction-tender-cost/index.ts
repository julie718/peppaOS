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

function flags(text: string): string[] {
  return [
    [/工期|delay|liquidated|违约|penalty/i, 'schedule/penalty'],
    [/质保|warranty|defect/i, 'warranty/defect liability'],
    [/付款|payment|advance|retainage|保留金/i, 'payment/retainage'],
    [/变更|variation|change order/i, 'change order'],
    [/安全|safety|permit|许可证/i, 'safety/permit'],
  ].filter(([re]) => (re as RegExp).test(text)).map(([, label]) => label as string);
}

const server = new McpServer({ name: 'construction-tender-cost', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('boq_review_checklist', {
  description: 'Create a bill-of-quantities review checklist and missing-data list from BOQ notes.',
  inputSchema: {
    boqText: z.string().describe('BOQ, quantity, material, or estimate notes'),
    projectType: z.string().optional().describe('Project type'),
  },
}, async (args: any) => {
  const rows = list(args.boqText);
  return ok({
    projectType: args.projectType || 'TBD',
    lineCount: rows.length,
    reviewChecklist: ['Item description/spec', 'Unit and quantity', 'Measurement rule', 'Material/brand grade', 'Labor/machine inclusion', 'Waste/loss rate', 'Tax and management fee', 'Scope boundary'],
    suspiciousLines: rows.filter(row => !/\d/.test(row) || /暂估|TBD|待定|lump sum|provisional/i.test(row)).slice(0, 20),
    reviewBoundary: 'Engineering quantities and formal estimates require qualified quantity surveyor/engineer review.',
  });
});

server.registerTool('tender_document_summary', {
  description: 'Summarize tender document notes into requirements, deadlines, submission materials, evaluation criteria, and risks.',
  inputSchema: {
    tenderText: z.string().describe('Tender document, announcement, or bid requirements'),
  },
}, async (args: any) => {
  const rows = list(args.tenderText);
  return ok({
    keyRequirements: rows.filter(row => /资质|资格|requirement|qualification|保证金|bond|证书/i.test(row)),
    deadlines: rows.filter(row => /截止|deadline|开标|submission|时间|date/i.test(row)),
    submissionMaterials: ['Bid letter', 'Qualification documents', 'Technical proposal', 'Commercial proposal/BOQ', 'Bid bond if required', 'Authorized signatures/seals'],
    evaluationCriteria: rows.filter(row => /评分|evaluation|price|technical|商务|技术/i.test(row)),
    riskFlags: flags(args.tenderText || ''),
  });
});

server.registerTool('bid_comparison_matrix', {
  description: 'Create a bid/vendor comparison matrix with price, technical response, schedule, risks, and clarification questions.',
  inputSchema: {
    bidsText: z.string().describe('Bidder/vendor proposal lines or quotation notes'),
  },
}, async (args: any) => {
  const bids = list(args.bidsText);
  return ok({
    comparisonFields: ['Bidder', 'Total price', 'Scope inclusion/exclusion', 'Technical compliance', 'Schedule', 'Payment terms', 'Warranty', 'Risk flags'],
    bidders: bids.map((bid, index) => ({ bidder: `Bidder ${index + 1}`, bid, riskFlags: flags(bid) })),
    clarificationQuestions: ['What is excluded?', 'Are quantities/specs aligned?', 'What is the delivery/construction schedule?', 'How are changes priced?', 'What warranty and penalty terms apply?'],
  });
});

server.registerTool('construction_milestone_plan', {
  description: 'Turn construction notes into milestone plan, dependencies, acceptance points, and delay risks.',
  inputSchema: {
    projectNotes: z.string().describe('Construction project notes, schedule, or site plan'),
    targetDate: z.string().optional().describe('Target completion date'),
  },
}, async (args: any) => {
  const notes = list(args.projectNotes);
  return ok({
    targetDate: args.targetDate || 'TBD',
    milestones: ['Mobilization', 'Material approval/procurement', 'Hidden works', 'Main construction', 'Inspection/testing', 'Rectification', 'Handover/settlement'],
    dependencies: notes.filter(note => /依赖|等待|permit|approval|材料|图纸|design|owner/i.test(note)),
    delayRisks: notes.filter(note => /延期|delay|blocked|停工|变更|天气/i.test(note)),
    acceptancePoints: ['Approved drawings/specs', 'Inspection records', 'Photo evidence', 'Test reports', 'Signed acceptance sheet'],
  });
});

server.registerTool('risky_clause_review', {
  description: 'Flag risky construction/tender clauses and produce review questions. Not legal advice.',
  inputSchema: {
    clauseText: z.string().describe('Contract, tender, or clause text'),
  },
}, async (args: any) => {
  const text = String(args.clauseText || '');
  return ok({
    riskFlags: flags(text),
    reviewQuestions: ['Is scope clear and measurable?', 'Are payment milestones tied to acceptance?', 'Are penalties capped?', 'How are variations priced and approved?', 'Who bears permit/site condition risks?', 'What documents are needed for settlement?'],
    saferAction: 'Mark clauses for business/legal/engineering review and ask for clarification before bid submission or signature.',
    boundary: 'This is a risk checklist, not legal or engineering advice.',
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
