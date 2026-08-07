import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  analyzeMenuMargin,
  analyzePromotionRoi,
  analyzeWaste,
  buildShiftPlan,
  summarizeReviews,
} from './logic';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'restaurant-store-ops', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('menu_margin_analyzer', {
  description: 'Analyze menu/item price, cost, sales, unit margin, gross profit, and low-margin review items.',
  inputSchema: {
    menuText: z.string().describe('Menu lines. Example: Latte price 28 cost 9 sales 120.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(analyzeMenuMargin(args)));

server.registerTool('waste_loss_report', {
  description: 'Analyze food/product waste by quantity, unit cost, sold quantity, value, waste rate, and controls.',
  inputSchema: {
    wasteText: z.string().describe('Waste lines. Example: Milk waste 6 unitCost 12 sold 80.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(analyzeWaste(args)));

server.registerTool('store_shift_planner', {
  description: 'Draft a simple staff shift focus plan from forecast orders by period, staff count, and labor budget hours.',
  inputSchema: {
    forecastText: z.string().describe('Forecast lines by period. Example: lunch orders 120; afternoon orders 35.'),
    staffCount: z.number().optional().describe('Available staff count'),
    laborBudgetHours: z.number().optional().describe('Labor budget hours'),
  },
}, async (args: any) => ok(buildShiftPlan(args)));

server.registerTool('review_theme_summary', {
  description: 'Summarize restaurant/store reviews into themes, negative samples, and action ideas.',
  inputSchema: {
    reviewText: z.string().describe('Customer reviews, one per line'),
  },
}, async (args: any) => ok(summarizeReviews(args)));

server.registerTool('promotion_roi_review', {
  description: 'Analyze store promotion revenue, discount, ad cost, orders, contribution, and loss-making warnings.',
  inputSchema: {
    promotionText: z.string().describe('Promotion lines. Example: Weekend set revenue 5000 discount 800 ad 300 orders 120.'),
    grossMarginRate: z.number().optional().describe('Gross margin rate before discounts/ads. Accepts 0.55 or 55 for 55%.'),
    currency: z.string().optional().describe('Currency code or symbol'),
  },
}, async (args: any) => ok(analyzePromotionRoi(args)));

const transport = new StdioServerTransport();
await server.connect(transport);
