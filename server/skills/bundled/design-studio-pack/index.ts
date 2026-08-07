import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function list(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

const server = new McpServer({ name: 'design-studio-pack', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('design_brief_builder', {
  description: 'Build a practical creative/design brief from project goals, audience, channels, brand constraints, and deliverables.',
  inputSchema: {
    projectName: z.string().describe('Project or campaign name'),
    audience: z.string().describe('Target audience'),
    goals: z.union([z.string(), z.array(z.string())]).describe('Business or design goals'),
    channels: z.union([z.string(), z.array(z.string())]).optional().describe('Channels: app, web, poster, social, packaging, etc.'),
    constraints: z.string().optional().describe('Brand, legal, production, budget, or deadline constraints'),
  },
}, async (args: any) => ok({
  projectName: args.projectName,
  audience: args.audience,
  goals: list(args.goals),
  channels: list(args.channels),
  creativeProblem: `Create a design response for ${args.audience} that serves ${list(args.goals).join(', ') || 'the stated goals'}.`,
  deliverables: ['Mood direction', 'Copy tone', 'Layout system', 'Asset checklist', 'Review criteria'],
  constraints: args.constraints || '',
  nextSteps: [
    'Collect references and non-references.',
    'Choose 2-3 visual directions before producing final assets.',
    'Define typography, color, spacing, imagery, and motion rules.',
    'Prepare export specs for the actual channel.',
  ],
}));

server.registerTool('design_review_checklist', {
  description: 'Review a UI, brand, poster, landing page, or visual asset against professional design criteria.',
  inputSchema: {
    artifactType: z.string().describe('UI screen, landing page, logo, poster, deck, packaging, etc.'),
    platform: z.string().optional().describe('iOS, Android, desktop, web, print, social media, etc.'),
    concerns: z.string().optional().describe('Known concerns or review focus'),
  },
}, async (args: any) => ok({
  artifactType: args.artifactType,
  platform: args.platform || 'general',
  checklist: [
    'Message hierarchy is clear within 3 seconds.',
    'Typography scale matches the density and purpose of the surface.',
    'Spacing, alignment, and rhythm are consistent.',
    'Color contrast and states are accessible.',
    'Primary action is visually obvious and not competing with decoration.',
    'Assets are export-ready for the target platform.',
    'Brand cues are present without crowding the main task.',
  ],
  reviewFocus: args.concerns || '',
  outputFormat: ['Severity', 'Issue', 'Why it matters', 'Suggested fix'],
}));

server.registerTool('visual_direction_board', {
  description: 'Create 2-3 visual direction concepts with mood, palette, typography, image style, and generation prompts.',
  inputSchema: {
    brand: z.string().describe('Brand/product/person/venue name'),
    mood: z.string().describe('Desired mood or keywords'),
    audience: z.string().optional().describe('Target audience'),
    mustAvoid: z.string().optional().describe('Things to avoid'),
  },
}, async (args: any) => {
  const base = `${args.brand}, ${args.mood}, ${args.audience || 'general audience'}`;
  return ok({
    brand: args.brand,
    directions: [
      {
        name: 'Quiet Premium',
        palette: ['charcoal', 'warm white', 'muted gold', 'soft gray'],
        type: 'Elegant sans serif with restrained contrast',
        imagery: 'Real product or place photography, calm lighting, minimal props',
        prompt: `${base}, quiet premium editorial photography, restrained composition, natural light`,
      },
      {
        name: 'Operational Clarity',
        palette: ['ink black', 'signal blue', 'white', 'cool gray'],
        type: 'Dense functional UI typography',
        imagery: 'Screens, workflows, tables, process visuals',
        prompt: `${base}, precise interface system, clean information design, professional workflow`,
      },
      {
        name: 'Expressive Energy',
        palette: ['deep green', 'electric cyan', 'coral', 'black'],
        type: 'Confident geometric display paired with readable body text',
        imagery: 'Dynamic angles, close-up details, motion cues',
        prompt: `${base}, expressive campaign visual, energetic composition, crisp detail`,
      },
    ],
    avoid: args.mustAvoid || '',
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
