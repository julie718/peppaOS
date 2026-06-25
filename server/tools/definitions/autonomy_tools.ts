import { ToolRegistry } from '../registry';
import { getGateConfig, saveGateConfig, SafetyGateConfig } from '../../autonomy/safety_gate';
import {
  listAutonomousWorkflows,
  setAutonomousWorkflowEnabled,
  upsertAutonomousWorkflow,
} from '../../autonomy/workflows';

const ALLOWED_KEYS = new Set<keyof SafetyGateConfig>([
  'alwaysOnline',
  'autoProcessEnabled',
  'externalAppAutomationEnabled',
  'messagingSendRequiresConfirmation',
  'maxConsecutiveTasks',
  'allowedHours',
  'requireIdle',
  'minIdleSeconds',
  'maxTokensPerHour',
  'quietHoursEnabled',
  'quietHoursStart',
  'quietHoursEnd',
]);

function pickGatePatch(args: Record<string, any>): Partial<SafetyGateConfig> {
  const patch: Partial<SafetyGateConfig> = {};
  for (const key of ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      (patch as any)[key] = args[key];
    }
  }
  return patch;
}

export function registerAutonomyTools(registry: ToolRegistry): void {
  registry.register({
    name: 'autonomy_get_policy',
    description: 'Read Lumi autonomous work safety policy: always-online, auto processing, external app automation, idle gate, time window, and budget.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => JSON.stringify(getGateConfig(), null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'autonomy_update_policy',
    description: 'Update Lumi autonomous work safety policy after explicit user confirmation. Use when the user agrees to a background workflow, 24-hour work window, or external app automation.',
    parameters: {
      type: 'object',
      properties: {
        alwaysOnline: { type: 'boolean', description: 'Keep Lumi ready while the client/server is running.' },
        autoProcessEnabled: { type: 'boolean', description: 'Allow queued confirmed workflows to run in the background.' },
        externalAppAutomationEnabled: { type: 'boolean', description: 'Allow opening/controlling external apps from adapters or autonomous work.' },
        messagingSendRequiresConfirmation: { type: 'boolean', description: 'Require confirmation before sending messages. Keep true unless an approved integration exists.' },
        maxConsecutiveTasks: { type: 'number', description: 'Maximum autonomous tasks per scheduler cycle, 1-10.' },
        allowedHours: { type: 'array', description: 'Allowed execution windows, e.g. [{start:0,end:24}] for 24h.' },
        requireIdle: { type: 'boolean', description: 'Require the user to be idle before background execution.' },
        minIdleSeconds: { type: 'number', description: 'Minimum idle seconds before background execution.' },
        maxTokensPerHour: { type: 'number', description: 'Hourly token budget for autonomous work.' },
        quietHoursEnabled: { type: 'boolean', description: 'Suppress proactive notifications during quiet hours.' },
        quietHoursStart: { type: 'number', description: 'Quiet hour start, 0-23.' },
        quietHoursEnd: { type: 'number', description: 'Quiet hour end, 0-23.' },
        reason: { type: 'string', description: 'Short reason/user instruction for auditability.' },
      },
      required: [],
    },
    handler: async (args) => {
      const patch = pickGatePatch(args);
      if (Object.keys(patch).length === 0) {
        throw new Error('No autonomy policy fields were provided.');
      }
      const updated = saveGateConfig(patch);
      return JSON.stringify({
        updated,
        reason: args.reason || '',
        note: 'Autonomy policy updated. Background execution still checks mode, idle/time, token budget, and tool safety gates.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'autonomy_list_workflows',
    description: 'List confirmed autonomous workflows for this user. Lumi may only auto-generate background tasks from enabled workflows.',
    parameters: {
      type: 'object',
      properties: {
        enabledOnly: { type: 'boolean', description: 'When true, return only enabled workflows.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const workflows = listAutonomousWorkflows(context?.userId || 'anonymous')
        .filter(workflow => !args.enabledOnly || workflow.enabled);
      return JSON.stringify({ workflows }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'autonomy_register_workflow',
    description: 'Register or update a user-confirmed background workflow. Use only after the user clearly agrees what Lumi may do automatically.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing workflow id when updating.' },
        title: { type: 'string', description: 'Short workflow title.' },
        description: { type: 'string', description: 'What Lumi should accomplish.' },
        trigger: { type: 'string', description: 'When Lumi may consider this workflow, e.g. every workday morning, when a meeting ends, when a CAD request appears.' },
        allowedModes: {
          type: 'array',
          description: 'Allowed execution modes: analysis, desktop, terminal.',
        },
        allowedActions: {
          type: 'array',
          description: 'Allowed action/tool families, e.g. knowledge, browser, wechat_draft, cad_dxf, runtime_logs, files.',
        },
        externalAppsAllowed: { type: 'boolean', description: 'Whether this workflow may use confirmed external app adapters.' },
        enabled: { type: 'boolean', description: 'Whether the workflow is enabled.' },
        reason: { type: 'string', description: 'Short user-facing reason for auditability.' },
      },
      required: ['title', 'description', 'trigger'],
    },
    handler: async (args, context) => {
      const workflow = upsertAutonomousWorkflow(context?.userId || 'anonymous', {
        id: args.id,
        title: args.title,
        description: args.description,
        trigger: args.trigger,
        allowedModes: args.allowedModes,
        allowedActions: args.allowedActions,
        externalAppsAllowed: args.externalAppsAllowed,
        enabled: args.enabled,
      });
      return JSON.stringify({
        workflow,
        reason: args.reason || '',
        note: 'Workflow registered. Lumi can only auto-generate background tasks from enabled confirmed workflows and still obeys the autonomy policy gate.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'autonomy_set_workflow_enabled',
    description: 'Enable or disable a confirmed autonomous workflow.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Workflow id.' },
        enabled: { type: 'boolean', description: 'Desired enabled state.' },
        reason: { type: 'string', description: 'Short reason for auditability.' },
      },
      required: ['id', 'enabled'],
    },
    handler: async (args, context) => {
      const workflow = setAutonomousWorkflowEnabled(context?.userId || 'anonymous', String(args.id || ''), Boolean(args.enabled));
      if (!workflow) {
        throw new Error(`Autonomous workflow not found: ${args.id}`);
      }
      return JSON.stringify({
        workflow,
        reason: args.reason || '',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });
}
