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

const server = new McpServer({ name: 'live-commerce', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('live_rundown_script', {
  description: 'Create a livestream rundown with opening, product segments, transitions, interaction prompts, and closing CTA.',
  inputSchema: {
    theme: z.string().describe('Live theme or sales event'),
    products: z.union([z.string(), z.array(z.string())]).optional().describe('Products or SKUs'),
    durationMinutes: z.number().optional().describe('Target duration'),
  },
}, async (args: any) => {
  const products = list(args.products || '');
  const duration = Math.max(20, Math.min(240, Number(args.durationMinutes || 60)));
  return ok({
    theme: args.theme,
    durationMinutes: duration,
    rundown: [
      { section: 'Opening', minutes: '0-5', script: 'Welcome, state today’s value and limited-time benefits, invite follows/comments.' },
      ...products.slice(0, 8).map((product, index) => ({ section: `Product ${index + 1}`, product, minutes: '6-10 each', script: 'Pain point, proof/demo, offer, FAQ, CTA.' })),
      { section: 'Recap', minutes: 'final 5', script: 'Repeat top offers, answer urgent questions, remind after-sales and order steps.' },
    ],
    controlRoomNotes: ['Pin key offer', 'Track stock/price changes', 'Collect repeated questions', 'Flag compliance-sensitive claims'],
  });
});

server.registerTool('product_lineup_planner', {
  description: 'Plan live commerce product lineup order, selling point, role, and risk checks.',
  inputSchema: {
    productText: z.string().describe('Product list, prices, stock, margins, offers, and notes'),
  },
}, async (args: any) => {
  const products = list(args.productText);
  return ok({
    lineup: products.map((product, index) => ({
      product,
      suggestedRole: index === 0 ? 'traffic opener' : index % 3 === 0 ? 'profit item' : 'conversion item',
      segmentFocus: /库存|stock|clearance|清仓/i.test(product) ? 'urgency and stock' : /高毛利|profit|margin/i.test(product) ? 'value and margin' : 'use case and proof',
      riskChecks: ['Price accuracy', 'Stock lock', 'Claim compliance', 'After-sales policy', 'Visual/demo material'],
    })),
    sequenceAdvice: ['Open with easy-to-understand offer', 'Place high-proof items before high-price items', 'Repeat core SKU after traffic peaks'],
  });
});

server.registerTool('host_prompt_cards', {
  description: 'Generate host prompt cards for product selling points, objections, interactions, and emergency fillers.',
  inputSchema: {
    product: z.string().describe('Product or product group'),
    sellingPoints: z.union([z.string(), z.array(z.string())]).optional().describe('Selling points'),
    objections: z.union([z.string(), z.array(z.string())]).optional().describe('Common objections'),
  },
}, async (args: any) => ok({
  product: args.product,
  sellingPointCards: list(args.sellingPoints).map(point => `Point: ${point}. Proof/demo: show one concrete detail. CTA: ask viewers to click/pin/comment.`),
  objectionCards: list(args.objections).map(objection => `Objection: ${objection}. Response: acknowledge, compare use case, clarify policy, avoid exaggerated claims.`),
  interactionPrompts: ['Where are you watching from?', 'Comment your use case and I will match the option.', 'Type 1 if you want the checklist.', 'Save this before checking out.'],
  emergencyFillers: ['Repeat offer rules', 'Show packing/detail shot', 'Read recent buyer question', 'Recap after-sales policy'],
}));

server.registerTool('live_conversion_review', {
  description: 'Review live session metrics into conversion bottlenecks, winning moments, and next experiment plan.',
  inputSchema: {
    metricsText: z.string().describe('Live metrics, product sales, traffic, comments, conversion, or GMV notes'),
  },
}, async (args: any) => {
  const rows = list(args.metricsText);
  return ok({
    notableSignals: rows.slice(0, 20),
    bottlenecks: ['Low entry: cover/title/traffic source', 'Low stay: opening hook/product pacing', 'Low click: offer clarity/product trust', 'Low conversion: price/stock/FAQ/checkout friction'],
    winningMomentsToClip: rows.filter(row => /高峰|peak|爆|转化|成交|GMV|click|点击/i.test(row)),
    nextExperiments: ['Test opening hook', 'Reorder product lineup', 'Prepare stronger proof/demo', 'Add objection cards', 'Repeat best SKU at peak time'],
  });
});

server.registerTool('live_after_sales_faq', {
  description: 'Create after-sales FAQ and comment response frames from product/policy notes.',
  inputSchema: {
    policyText: z.string().describe('Product policy, shipping, refund, warranty, and common issue notes'),
  },
}, async (args: any) => ok({
  faq: [
    { question: 'When will it ship?', answerFrame: 'State dispatch window, carrier update rule, and where to check tracking.' },
    { question: 'Can I return/refund?', answerFrame: 'Explain platform/store policy, required condition, and evidence needed.' },
    { question: 'Is it authentic/safe?', answerFrame: 'Use verifiable proof only, avoid unsupported claims.' },
    { question: 'Which option should I choose?', answerFrame: 'Ask use case/budget/size, then recommend based on stated needs.' },
  ],
  policySource: String(args.policyText || '').slice(0, 500),
  responseRules: ['Acknowledge', 'Answer directly', 'Do not overpromise', 'Move order-specific issues to private support'],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
