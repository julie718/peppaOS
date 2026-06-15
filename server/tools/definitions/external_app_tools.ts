import fs from 'fs';
import path from 'path';
import { ToolRegistry } from '../registry';
import { ToolContext } from '../types';
import { getDataPath } from '../../config/data_path';
import { getExternalAppAdapters } from '../../external_apps/adapters';
import { isExternalAppAutomationAllowed, isMessagingSendConfirmationRequired } from '../../autonomy/safety_gate';

function requireDesktopRelay(context?: ToolContext) {
  if (!context?.desktopRelay) {
    throw new Error('External app actions require the Lumi desktop client relay.');
  }
  return context.desktopRelay;
}

function requireExternalAutomation() {
  if (!isExternalAppAutomationAllowed()) {
    throw new Error('External app automation is disabled. Enable it in Settings > Auto Execute before opening or controlling external apps.');
  }
}

function normalizeUrl(args: Record<string, any>): string {
  const rawUrl = String(args.url || '').trim();
  const query = String(args.query || '').trim();
  if (rawUrl) {
    if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
    return `https://${rawUrl}`;
  }
  if (!query) throw new Error('Provide either url or query.');
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
}

function buildMessageDraft(args: Record<string, any>): string {
  const explicitDraft = String(args.draft || '').trim();
  if (explicitDraft) return explicitDraft;

  const contact = String(args.contact || '').trim();
  const context = String(args.context || '').trim();
  const intent = String(args.intent || 'reply clearly and helpfully').trim();
  const tone = String(args.tone || 'warm and concise').trim();

  const lines = [
    contact ? `${contact}，` : '',
    `我看到了，我这边会按“${intent}”来处理。`,
  ];
  if (context) {
    lines.push(`关于你提到的“${context.slice(0, 160)}”，我会先确认关键点，再推进下一步。`);
  }
  lines.push(tone.includes('formal') ? '如有变动我会及时同步。' : '有变化我马上同步你。');
  return lines.filter(Boolean).join('\n');
}

function safeFileName(value: string): string {
  return (value || 'cad_drawing')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'cad_drawing';
}

function dxfLine(x1: number, y1: number, x2: number, y2: number, layer = 'CUT'): string[] {
  return ['0', 'LINE', '8', layer, '10', String(x1), '20', String(y1), '30', '0', '11', String(x2), '21', String(y2), '31', '0'];
}

function dxfCircle(x: number, y: number, r: number, layer = 'HOLE'): string[] {
  return ['0', 'CIRCLE', '8', layer, '10', String(x), '20', String(y), '30', '0', '40', String(r)];
}

function dxfArc(cx: number, cy: number, r: number, start: number, end: number, layer = 'CUT'): string[] {
  return ['0', 'ARC', '8', layer, '10', String(cx), '20', String(cy), '30', '0', '40', String(r), '50', String(start), '51', String(end)];
}

function buildRoundedRectEntities(width: number, height: number, radius: number): string[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r <= 0) {
    return [
      ...dxfLine(0, 0, w, 0),
      ...dxfLine(w, 0, w, h),
      ...dxfLine(w, h, 0, h),
      ...dxfLine(0, h, 0, 0),
    ];
  }
  return [
    ...dxfLine(r, 0, w - r, 0),
    ...dxfLine(w, r, w, h - r),
    ...dxfLine(w - r, h, r, h),
    ...dxfLine(0, h - r, 0, r),
    ...dxfArc(w - r, r, r, 270, 360),
    ...dxfArc(w - r, h - r, r, 0, 90),
    ...dxfArc(r, h - r, r, 90, 180),
    ...dxfArc(r, r, r, 180, 270),
  ];
}

function buildDxf(args: Record<string, any>): string {
  const width = Math.max(1, Number(args.width) || 100);
  const height = Math.max(1, Number(args.height) || 60);
  const radius = Math.max(0, Number(args.cornerRadius) || 0);
  const holes = Array.isArray(args.holes) ? args.holes : [];
  const entities: string[] = [
    '0', 'SECTION', '2', 'ENTITIES',
    ...buildRoundedRectEntities(width, height, radius),
  ];

  for (const hole of holes.slice(0, 40)) {
    const x = Number(hole?.x);
    const y = Number(hole?.y);
    const r = Number(hole?.r ?? hole?.radius);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(r) && r > 0) {
      entities.push(...dxfCircle(x, y, r));
    }
  }

  entities.push('0', 'ENDSEC', '0', 'EOF');
  return `${entities.join('\n')}\n`;
}

export function registerExternalAppTools(registry: ToolRegistry): void {
  registry.register({
    name: 'external_app_list_adapters',
    description: 'List Lumi external app adapters and their safety policies for browser, messaging, CAD, and other AI apps.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => JSON.stringify({
      externalAppAutomationEnabled: isExternalAppAutomationAllowed(),
      messagingSendRequiresConfirmation: isMessagingSendConfirmationRequired(),
      adapters: getExternalAppAdapters(),
    }, null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'browser_open_task',
    description: 'Prepare or open a browser task. By default returns the target URL without opening it; set open=true only when the user wants the browser opened.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open. If omitted, query is converted to a Bing search URL.' },
        query: { type: 'string', description: 'Search query when no URL is provided.' },
        open: { type: 'boolean', description: 'Open the URL in the desktop browser. Requires external app automation.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const target = normalizeUrl(args);
      if (!args.open) {
        return JSON.stringify({ target, opened: false, note: 'Set open=true after user confirmation to open the browser.' }, null, 2);
      }
      requireExternalAutomation();
      const desktopRelay = requireDesktopRelay(context);
      const result = await desktopRelay('desktop_open', { target });
      return JSON.stringify({ target, opened: true, result }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'wechat_prepare_reply',
    description: 'Prepare a WeChat or messaging reply draft. This tool never sends messages.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Recipient name or group name.' },
        context: { type: 'string', description: 'Relevant message context from the user.' },
        intent: { type: 'string', description: 'What the reply should accomplish.' },
        tone: { type: 'string', description: 'Tone, e.g. concise, warm, formal, apologetic.' },
        draft: { type: 'string', description: 'Use this exact draft if already written.' },
      },
      required: [],
    },
    handler: async (args) => JSON.stringify({
      draft: buildMessageDraft(args),
      sendAllowed: false,
      note: 'Lumi prepared a draft only. Sending stays user-confirmed.',
    }, null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'wechat_copy_reply_draft',
    description: 'Copy a prepared WeChat/messaging reply draft to clipboard and optionally open WeChat. This never presses Send.',
    parameters: {
      type: 'object',
      properties: {
        draft: { type: 'string', description: 'Reply draft to copy.' },
        openWechat: { type: 'boolean', description: 'Open WeChat after copying the draft.' },
        applicationTarget: { type: 'string', description: 'Optional app target, default wechat.exe.' },
      },
      required: ['draft'],
    },
    handler: async (args, context) => {
      requireExternalAutomation();
      const draft = String(args.draft || '').trim();
      if (!draft) throw new Error('Draft is required.');
      const desktopRelay = requireDesktopRelay(context);
      const copied = await desktopRelay('desktop_clipboard_write', { text: draft });
      let opened: string | undefined;
      if (args.openWechat) {
        opened = await desktopRelay('desktop_open', { target: args.applicationTarget || 'wechat.exe' });
      }
      return JSON.stringify({
        copied: true,
        clipboardResult: copied,
        opened: Boolean(args.openWechat),
        openResult: opened,
        sendAllowed: !isMessagingSendConfirmationRequired(),
        note: 'The draft is ready on the clipboard. Lumi did not send the message.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'cad_generate_dxf',
    description: 'Generate a simple CAD DXF draft with an outline and optional holes. Use this as a first drafting handoff, not as final engineering verification.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Drawing title / output filename.' },
        width: { type: 'number', description: 'Outer width in chosen units.' },
        height: { type: 'number', description: 'Outer height in chosen units.' },
        unit: { type: 'string', description: 'Unit label, e.g. mm, cm, inch.' },
        cornerRadius: { type: 'number', description: 'Optional rounded corner radius.' },
        holes: {
          type: 'array',
          description: 'Optional holes as objects with x, y, and r/radius.',
          items: { type: 'object' },
        },
        openPreview: { type: 'boolean', description: 'Open the generated DXF with the system default app. Requires external app automation.' },
      },
      required: ['width', 'height'],
    },
    handler: async (args, context) => {
      const title = safeFileName(String(args.title || 'lumi_cad_draft'));
      const outPath = getDataPath(path.join('cad', `${title}_${Date.now()}.dxf`));
      fs.writeFileSync(outPath, buildDxf(args), 'utf-8');

      let openResult: string | undefined;
      if (args.openPreview) {
        requireExternalAutomation();
        const desktopRelay = requireDesktopRelay(context);
        openResult = await desktopRelay('desktop_open', { target: outPath });
      }

      return JSON.stringify({
        path: outPath,
        title,
        unit: args.unit || 'unit',
        width: Number(args.width) || 100,
        height: Number(args.height) || 60,
        holes: Array.isArray(args.holes) ? args.holes.length : 0,
        opened: Boolean(args.openPreview),
        openResult,
        note: 'Generated a DXF draft. Review dimensions and tolerances before production use.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });
}
