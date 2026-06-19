import { buildSelfExtensionPlan } from '../../self_extension/pipeline';
import { getClientState } from '../../client/self_model';
import { ToolRegistry } from '../registry';

export function registerSelfExtensionTools(registry: ToolRegistry): void {
  registry.register({
    name: 'self_extension_plan',
    description: [
      'Plan how Lumi should extend itself when a requested capability appears missing or incomplete.',
      'This inspects the client adapter registry, installed skills, marketplace skills, and current tool registry.',
      'It returns whether Lumi should use existing tools, repair/install a skill, research an adapter, generate a skill draft, or escalate to core code work.',
      'This tool does not install, generate, execute third-party code, or modify Lumi core by itself.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The missing or desired capability, e.g. "summarize today model usage", "control Revit", or "reply to Feishu messages".',
        },
        domain: {
          type: 'string',
          description: 'Optional domain hint, e.g. usage_monitoring, client_control, cad_bim, messaging, legal, design, finance, music, files.',
        },
      },
      required: ['goal'],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const plan = buildSelfExtensionPlan({
        userId,
        goal: String(args.goal || ''),
        domain: args.domain ? String(args.domain) : undefined,
        clientState: getClientState(userId) as Record<string, any> | null,
        tools: registry.list(),
      });
      return JSON.stringify(plan, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}
