import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runLegalCaseFolderWorkflow } from './folder_workflow';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function splitList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const server = new McpServer({ name: 'legal-casework', version: '1.1.0' }, { capabilities: { tools: {} } });

server.registerTool('legal_case_intake', {
  description: 'Turn raw case facts into a lawyer-facing intake brief: parties, stage, issues, evidence gaps, risk points, and next actions. This is legal work support, not final legal advice.',
  inputSchema: {
    caseName: z.string().optional().describe('Case name or short matter title'),
    caseType: z.string().describe('Matter type, e.g. contract dispute, labor, divorce, enforcement, criminal defense'),
    stage: z.string().optional().describe('Current stage: consultation, filing, hearing, judgment, appeal, enforcement'),
    parties: z.union([z.string(), z.array(z.string())]).optional().describe('Parties and roles'),
    facts: z.string().describe('Known facts, preferably chronological'),
    objective: z.string().optional().describe('Client/lawyer objective'),
  },
}, async (args: any) => {
  const facts = String(args.facts || '').trim();
  const parties = splitList(args.parties);
  const caseType = String(args.caseType || 'general matter');
  const stage = String(args.stage || 'consultation');
  return ok({
    caseName: args.caseName || 'Untitled matter',
    caseType,
    stage,
    parties,
    objective: args.objective || 'Clarify claim, evidence, risks, and next procedural step.',
    factSummary: facts.slice(0, 1200),
    issueMap: [
      `Identify governing legal relationship for ${caseType}.`,
      'Separate proven facts, disputed facts, and facts requiring supplementation.',
      'Map claims/defenses to evidence already available.',
      'Check limitation periods, jurisdiction, and procedural deadlines.',
    ],
    evidenceChecklist: [
      'Identity/business registration materials for all parties.',
      'Core contract/order/chat/payment/performance records.',
      'Chronology with dates, amounts, locations, and witnesses.',
      'Prior notices, demand letters, court/arbitration documents, or enforcement clues.',
    ],
    nextActions: [
      'Ask for missing original documents and source files.',
      'Build a timeline and tag each fact with supporting evidence.',
      'Run similar-case and statute search before drafting formal documents.',
      'Have a lawyer review final legal opinions and filing documents.',
    ],
    boundary: '辅助律师分析，最终法律判断和正式意见需由律师确认。',
  });
});

server.registerTool('legal_deadline_planner', {
  description: 'Calculate common legal work deadlines from a base date and produce reminder dates. Jurisdiction-specific rules must be reviewed by a lawyer.',
  inputSchema: {
    baseDate: z.string().describe('Base date in YYYY-MM-DD format'),
    deadlineType: z.enum(['civil_appeal_cn_15d', 'admin_appeal_cn_15d', 'enforcement_apply_cn_2y', 'hearing_prep', 'custom']).describe('Deadline template'),
    customDays: z.number().optional().describe('Custom day count when deadlineType is custom'),
    note: z.string().optional().describe('Context note, e.g. judgment served, hearing notice received'),
  },
}, async (args: any) => {
  const base = new Date(String(args.baseDate || ''));
  if (Number.isNaN(base.getTime())) {
    return { content: [{ type: 'text' as const, text: 'Invalid baseDate. Use YYYY-MM-DD.' }], isError: true };
  }
  const daysByType: Record<string, number> = {
    civil_appeal_cn_15d: 15,
    admin_appeal_cn_15d: 15,
    enforcement_apply_cn_2y: 730,
    hearing_prep: 7,
    custom: Number(args.customDays || 0),
  };
  const days = daysByType[String(args.deadlineType || 'custom')];
  if (!days || days < 0) {
    return { content: [{ type: 'text' as const, text: 'customDays must be a positive number for custom deadlines.' }], isError: true };
  }
  const due = addDays(base, days);
  return ok({
    baseDate: formatDate(base),
    deadlineType: args.deadlineType,
    dueDate: formatDate(due),
    reminders: [Math.max(days - 7, 1), Math.max(days - 3, 1), Math.max(days - 1, 1)]
      .filter((v, idx, arr) => arr.indexOf(v) === idx)
      .map(offset => ({ date: formatDate(addDays(base, offset)), label: `${days - offset} day(s) before due date` })),
    note: args.note || '',
    warning: 'Confirm service date, holiday rules, jurisdiction, and procedural law before relying on this date.',
  });
});

server.registerTool('legal_document_outline', {
  description: 'Generate a lawyer-facing outline for common legal documents such as complaint, answer, engagement letter, legal memo, hearing outline, or case file index.',
  inputSchema: {
    documentType: z.enum(['engagement_letter', 'complaint', 'answer', 'legal_memo', 'hearing_outline', 'case_file_index']).describe('Document type'),
    caseType: z.string().optional().describe('Matter type'),
    facts: z.string().optional().describe('Core facts or dispute summary'),
    requestedRelief: z.string().optional().describe('Claims, defenses, or requested relief'),
  },
}, async (args: any) => {
  const common = ['Matter overview', 'Parties and roles', 'Chronology', 'Evidence list', 'Open questions', 'Lawyer review notes'];
  const outlines: Record<string, string[]> = {
    engagement_letter: ['Client identity', 'Entrusted matter', 'Scope of service', 'Fees and expenses', 'Client obligations', 'Confidentiality', 'Signatures'],
    complaint: ['Court and parties', 'Claims', 'Facts and reasons', 'Evidence catalogue', 'Jurisdiction basis', 'Attachments'],
    answer: ['Basic position', 'Response to claims', 'Facts in dispute', 'Legal basis', 'Evidence catalogue', 'Procedural objections'],
    legal_memo: ['Question presented', 'Brief answer', 'Facts', 'Applicable rules', 'Analysis', 'Risks', 'Recommended next steps'],
    hearing_outline: ['Case theory', 'Issues for hearing', 'Evidence presentation order', 'Questions for parties/witnesses', 'Debate points', 'Settlement fallback'],
    case_file_index: ['Client materials', 'Identity materials', 'Contracts and transaction records', 'Communications', 'Court documents', 'Generated work product'],
  };
  return ok({
    documentType: args.documentType,
    caseType: args.caseType || 'general',
    outline: outlines[String(args.documentType)] || common,
    commonAppendix: common,
    draftingNotes: [
      'Keep statements tied to evidence.',
      'Mark unverified facts clearly.',
      'Do not present AI output as final legal opinion without lawyer review.',
    ],
    sourceFacts: args.facts || '',
    requestedRelief: args.requestedRelief || '',
  });
});

server.registerTool('legal_case_folder_workflow', {
  description: 'Read a local case folder, extract text from mixed legal materials, identify case signals, build authorized Faxin/China Judgments search plans, and draft lawyer-facing work papers such as engagement points, power of attorney, agency statement outline, and evidence catalogue. External legal sites require user-authorized login and manual captcha/2FA completion.',
  inputSchema: {
    folderPath: z.string().describe('Local folder path containing case materials, e.g. Desktop\\某案件材料'),
    caseName: z.string().optional().describe('Case name or short matter title'),
    matterType: z.string().optional().describe('Matter type or cause of action, e.g. sales contract dispute'),
    stage: z.string().optional().describe('Current stage: intake, filing, hearing, appeal, enforcement, arbitration'),
    clientRole: z.string().optional().describe('Client role, e.g. plaintiff, defendant, applicant, respondent'),
    objective: z.string().optional().describe('Target output, e.g. organize retainer package, draft agency statement, build evidence catalogue'),
    outputDir: z.string().optional().describe('Optional output folder. Defaults to Lumi legal work papers under the case folder.'),
    writeFiles: z.boolean().optional().describe('Whether to write draft markdown files to disk. If false, only previews are returned.'),
    maxFiles: z.number().int().min(1).max(300).optional().describe('Maximum number of files to scan. Default 80.'),
    maxChars: z.number().int().min(10000).max(800000).optional().describe('Maximum extracted corpus size. Default 180000.'),
  },
}, async (args: any) => {
  return ok(await runLegalCaseFolderWorkflow(args));
});

const transport = new StdioServerTransport();
await server.connect(transport);
