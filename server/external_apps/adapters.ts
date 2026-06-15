export type ExternalAppAdapterId = 'browser' | 'wechat' | 'cad' | 'ai_apps';

export interface ExternalAppAdapter {
  id: ExternalAppAdapterId;
  label: string;
  status: 'ready' | 'draft_only' | 'requires_setup';
  actions: string[];
  safety: string;
  notes: string;
}

export const EXTERNAL_APP_ADAPTERS: ExternalAppAdapter[] = [
  {
    id: 'browser',
    label: 'Browser and web work',
    status: 'ready',
    actions: ['browser_open_task', 'web_search', 'url_fetch'],
    safety: 'Opening a URL is allowed; account actions, purchases, posts, and submissions still need user confirmation.',
    notes: 'Use this adapter for research, opening project pages, and continuing work in the default browser.',
  },
  {
    id: 'wechat',
    label: 'WeChat and messaging',
    status: 'draft_only',
    actions: ['wechat_prepare_reply', 'wechat_copy_reply_draft'],
    safety: 'Lumi can prepare and copy a reply draft. Sending messages must stay user-confirmed.',
    notes: 'This avoids brittle blind clicking while still making chat reply workflows useful.',
  },
  {
    id: 'cad',
    label: 'CAD drafting',
    status: 'draft_only',
    actions: ['cad_generate_dxf'],
    safety: 'Lumi generates DXF draft files first. Opening CAD or modifying production drawings needs confirmation.',
    notes: 'Good for simple outlines, plates, holes, layout sketches, and handoff drafts.',
  },
  {
    id: 'ai_apps',
    label: 'Other local AI agents',
    status: 'requires_setup',
    actions: ['external_app_list_adapters', 'computer_use'],
    safety: 'Use explicit tool or MCP integrations when available. Full UI control needs desktop automation confirmation.',
    notes: 'Lumi can coordinate other AI tools through browser, files, clipboard, MCP, or confirmed computer-use sessions.',
  },
];

export function getExternalAppAdapters(): ExternalAppAdapter[] {
  return EXTERNAL_APP_ADAPTERS;
}
