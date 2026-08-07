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

const server = new McpServer({ name: 'admin-assistant', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('schedule_conflict_planner', {
  description: 'Organize schedule notes into meetings, conflicts, preparation needs, and confirmation messages.',
  inputSchema: {
    scheduleText: z.string().describe('Schedule, calendar notes, chat messages, or appointments'),
    dateRange: z.string().optional().describe('Date range to plan'),
  },
}, async (args: any) => {
  const items = list(args.scheduleText);
  return ok({
    dateRange: args.dateRange || 'TBD',
    appointments: items,
    possibleConflicts: items.filter(item => /same time|冲突|撞|overlap|改期|同时/i.test(item)),
    preparationNeeded: items.filter(item => /会议|meeting|汇报|review|签字|资料|材料/i.test(item)).map(item => ({ item, prep: ['Agenda', 'Files/materials', 'Attendee confirmation', 'Decision needed'] })),
    confirmationTemplate: 'I have noted the schedule. Please confirm the time, location/link, attendees, and any materials needed before the meeting.',
  });
});

server.registerTool('meeting_minutes_admin', {
  description: 'Convert meeting notes into minutes, decisions, action items, owners, due dates, and follow-up message.',
  inputSchema: {
    meetingNotes: z.string().describe('Meeting notes or transcript snippets'),
    defaultOwner: z.string().optional().describe('Fallback owner'),
  },
}, async (args: any) => {
  const notes = list(args.meetingNotes);
  return ok({
    summary: notes.slice(0, 6),
    decisions: notes.filter(n => /决定|确认|approved|decision|agree/i.test(n)),
    actions: notes.filter(n => /todo|action|负责|跟进|完成|deadline|due/i.test(n)).map(action => ({ action, owner: args.defaultOwner || 'TBD', due: 'TBD' })),
    openQuestions: notes.filter(n => /问题|待确认|TBD|unclear|question/i.test(n)),
    followUpMessage: 'Meeting notes are summarized. Please confirm owners and deadlines for each action item.',
  });
});

server.registerTool('reimbursement_packet_check', {
  description: 'Review reimbursement notes into category, missing documents, approval path, and submission checklist.',
  inputSchema: {
    reimbursementText: z.string().describe('Expense, invoice, receipt, travel, or reimbursement notes'),
    policyHint: z.string().optional().describe('Company reimbursement policy hints'),
  },
}, async (args: any) => {
  const text = String(args.reimbursementText || '');
  return ok({
    categories: {
      travel: /travel|hotel|flight|taxi|差旅|酒店|机票|打车/i.test(text),
      meals: /meal|餐|招待|coffee|dinner/i.test(text),
      office: /office|stationery|办公|采购/i.test(text),
      client: /client|customer|客户|招待/i.test(text),
    },
    missingDocuments: ['Invoice/receipt', 'Payment proof', 'Approval screenshot or request id', 'Business purpose', 'Participant list if entertainment'],
    approvalPath: ['Employee submit', 'Manager review', 'Finance check', 'Payment/archive'],
    policyChecks: list(args.policyHint).concat(['Amount limit', 'Invoice title/tax number', 'Date within reimbursement period', 'No duplicate claim']),
  });
});

server.registerTool('office_purchase_request', {
  description: 'Create an office purchase request with need, options, budget, approval notes, and vendor comparison frame.',
  inputSchema: {
    requestText: z.string().describe('Purchase need or chat notes'),
    budget: z.number().optional().describe('Budget ceiling'),
  },
}, async (args: any) => ok({
  needSummary: String(args.requestText || '').slice(0, 300),
  budget: args.budget || 'TBD',
  purchaseRequest: {
    purpose: 'TBD based on requesting department',
    quantity: 'TBD',
    requiredDate: 'TBD',
    acceptanceStandard: 'Brand/spec/warranty/invoice/delivery confirmation',
  },
  comparisonFields: ['Vendor', 'Spec/model', 'Unit price', 'Delivery time', 'Warranty', 'Invoice/tax', 'After-sales'],
  approvalNotes: ['Confirm budget owner', 'Confirm urgency', 'Attach comparison screenshot/quote', 'Archive approval record'],
}));

server.registerTool('notice_and_archive_plan', {
  description: 'Draft an internal notice and create a filing/archive checklist for office documents.',
  inputSchema: {
    noticeTopic: z.string().describe('Notice topic or document batch'),
    audience: z.string().optional().describe('Audience or departments'),
    documents: z.union([z.string(), z.array(z.string())]).optional().describe('Documents to file/archive'),
  },
}, async (args: any) => ok({
  noticeDraft: `Notice: ${args.noticeTopic}\n\nPlease review the relevant details and complete any required actions by the stated deadline. Contact the responsible owner if clarification is needed.`,
  audience: args.audience || 'All relevant teams',
  archiveChecklist: list(args.documents).map(doc => ({ document: doc, folder: 'TBD', retention: 'Follow company policy', owner: 'TBD' })),
  filingRules: ['Use consistent naming', 'Store approval/version evidence', 'Restrict sensitive files', 'Record owner and date'],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
