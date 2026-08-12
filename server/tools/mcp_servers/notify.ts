// 阶段一·模块1: notify-mcp — 本地弹窗/终端消息推送，承载日程、情绪关怀、资讯简报推送
// 统一复用：notifications 表（pushNotification）+ socket 主动推送（emitProactivePush）+ 终端日志三通道。
import { ToolRegistry } from '../registry';
import { buildMcpServerFromRegistry } from './mcp_helpers';
import { logger } from '../../lib/logger';
import { classifyBuiltinToolRisk } from '../../skills_extension/risk_policy';
import { pushNotification } from '../../routes/notifications';
import { emitProactivePush } from '../../lib/pushService';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface NotifyPayload { type: string; title: string; message: string; scene?: string; priority?: 'low' | 'normal' | 'high' }

/** 三通道推送：本地通知表 + socket 主动推送（前端弹窗）+ 终端日志 */
export function notify(userId: string, payload: NotifyPayload): boolean {
  try { pushNotification(userId, { type: payload.type, title: payload.title, message: payload.message }); } catch (e: any) { logger.warn('[NotifyMCP] 通知表写入失败:', e?.message); }
  try { emitProactivePush({ scene: payload.scene || payload.type, content: `${payload.title}\n${payload.message}` }); } catch {}
  logger.info(`[NotifyMCP] 推送 [${payload.priority || 'normal'}] ${payload.type}: ${payload.title} → ${userId}`);
  return true;
}

async function notifyPush(args: Record<string, any>, userId: string): Promise<string> {
  const title = String(args.title || '').trim();
  const message = String(args.message || '').trim();
  if (!title || !message) throw new Error('title 与 message 为必填');
  const type = String(args.type || 'info').trim();
  notify(userId, { type, title, message, scene: String(args.scene || ''), priority: args.priority });
  return `✅ 已推送「${title}」（通道：通知表 + 主动推送 + 终端日志）`;
}

async function notifySchedule(args: Record<string, any>, userId: string): Promise<string> {
  // 日程/行程提醒转发：行程临近由 travel-upcoming 触发器驱动，此处提供手动触发入口
  const title = String(args.title || '日程提醒').trim();
  const at = String(args.at || '').trim();
  const content = `📅 ${at ? at + ' ' : ''}${String(args.content || '').trim()}`;
  notify(userId, { type: 'schedule', title, message: content, scene: 'schedule' });
  return `✅ 日程提醒已推送: ${title}`;
}

export function registerNotifyTools(registry: ToolRegistry): void {
  const tools = [
    { name: 'notify_push', desc: '本地弹窗/终端消息推送：写通知表 + socket 主动推送（前端弹窗）+ 终端日志。承载日程提醒、情绪关怀、资讯简报等场景', params: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' }, type: { type: 'string', description: 'info/travel/emotion/news/schedule' }, scene: { type: 'string' }, priority: { type: 'string', description: 'low/normal/high' } }, required: ['title', 'message'] }, handler: notifyPush },
    { name: 'notify_schedule', desc: '日程提醒推送：手动触发一条日程/安排提醒（行程临近自动提醒由触发器驱动）', params: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, at: { type: 'string' } }, required: ['content'] }, handler: notifySchedule },
  ];
  for (const t of tools) {
    registry.register({
      name: t.name,
      description: t.desc,
      parameters: t.params,
      handler: async (a: Record<string, any>) => t.handler(a, String(a.userId || process.env.E2E_UID || 'peppa-user')),
      permission: 'user',
      securityLevel: classifyBuiltinToolRisk(t.desc),
    });
  }
  logger.info(`[NotifyMCP] 已注册 ${tools.length} 个工具`);
}

export function createNotifyMcpServer(): McpServer {
  const registry = new ToolRegistry();
  registerNotifyTools(registry);
  return buildMcpServerFromRegistry('notify-mcp', '1.0.0', registry, ['notify_push', 'notify_schedule']);
}