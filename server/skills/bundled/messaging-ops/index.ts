import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'messaging-ops', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('remote_message_triage', {
  description: 'Triage a Feishu/WeChat/WeCom remote message into intent, urgency, requested action, needed files, and safe next response.',
  inputSchema: {
    platform: z.enum(['feishu', 'wechat', 'wecom', 'other']).describe('Message platform'),
    sender: z.string().optional().describe('Sender name or role'),
    text: z.string().describe('Message text'),
    attachments: z.array(z.string()).optional().describe('Attachment filenames or summaries'),
  },
}, async (args: any) => {
  const text = String(args.text || '');
  const urgent = /urgent|asap|immediately|马上|立刻|紧急|今天|开庭|截止|付款/i.test(text);
  const asksFile = /file|attachment|document|合同|材料|文件|图纸|发票|案件|资料/i.test(text);
  return ok({
    platform: args.platform,
    sender: args.sender || '',
    urgency: urgent ? 'high' : 'normal',
    intentHints: {
      wantsInformation: /查|找|search|find|资料|数据|案件|记录/i.test(text),
      wantsAction: /做|生成|整理|回复|发送|画|出|prepare|draft|create/i.test(text),
      includesFiles: asksFile || (Array.isArray(args.attachments) && args.attachments.length > 0),
    },
    recommendedHandling: [
      'Acknowledge receipt quickly.',
      'If files are referenced, confirm the exact file names and intended use.',
      'For external sending, draft first and ask confirmation before sending.',
      'Route organization data lookup through the organization workspace permissions.',
    ],
    attachments: args.attachments || [],
  });
});

server.registerTool('draft_remote_reply', {
  description: 'Draft a safe Feishu/WeChat reply. This tool never sends; it prepares text for user review and confirmation.',
  inputSchema: {
    platform: z.enum(['feishu', 'wechat', 'wecom', 'other']).describe('Message platform'),
    recipient: z.string().optional().describe('Recipient name'),
    context: z.string().describe('Conversation context or request'),
    objective: z.string().describe('What the reply should accomplish'),
    tone: z.string().optional().describe('Tone: concise, polite, warm, formal, firm, etc.'),
  },
}, async (args: any) => ok({
  platform: args.platform,
  recipient: args.recipient || '',
  sendRequiresConfirmation: true,
  draft: `${args.recipient ? `${args.recipient}，` : ''}收到。${args.objective}。我会先核对相关信息和材料，再把结果整理给你确认。`,
  reviewChecklist: [
    'Confirm no sensitive data is sent to the wrong chat.',
    'Confirm attachments are the intended files.',
    'Confirm tone and legal/business commitments before sending.',
  ],
  tone: args.tone || 'polite and concise',
  context: args.context,
}));

server.registerTool('feishu_wechat_setup_guide', {
  description: 'Explain the setup steps for Feishu, WeCom, or WeChat remote access to Lumi.',
  inputSchema: {
    platform: z.enum(['feishu', 'wecom', 'wechat']).describe('Platform to configure'),
    publicBaseUrl: z.string().optional().describe('Public callback base URL, if already known'),
  },
}, async (args: any) => {
  const base = String(args.publicBaseUrl || 'https://your-domain.example.com');
  const platform = String(args.platform);
  const endpoints: Record<string, string[]> = {
    feishu: [`${base}/api/feishu/events`, `${base}/api/feishu/send`],
    wecom: [`${base}/api/wecom/events`, `${base}/api/wecom/send`],
    wechat: [`${base}/api/wechat/qrcode`, `${base}/api/wechat/status`],
  };
  return ok({
    platform,
    endpoints: endpoints[platform],
    steps: [
      'Create or open the platform app/bot in the provider console.',
      'Copy credentials into Lumi Settings -> Messaging/Remote Access.',
      'Set the callback/event URL shown above.',
      'Generate a binding code in Lumi and send/bind it from the remote chat.',
      'Test with a low-risk message before using organization data or files.',
    ],
    boundary: 'Remote messages enter the same local Lumi. Multi-user routing should be explicit before team-wide deployment.',
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
