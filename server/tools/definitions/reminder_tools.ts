// 通用日历提醒工具 — SQLite 持久化，跨平台
import { ToolRegistry } from '../registry';
import { readDB, writeDB } from '../../../db_layer';
import { logger } from '../../../logger';
import { classifyBuiltinToolRisk } from '../../skills_extension/risk_policy';

function genId(): string {
  return `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

async function reminderCreate(args: Record<string, any>, context?: any): Promise<string> {
  const content = String(args.content || '').trim();
  if (!content) throw new Error('content 参数不能为空（提醒内容）');

  const dueAt = args.dueAt ? String(args.dueAt).trim() : null;
  const userId = context?.userId || 'default';

  const reminder = {
    id: genId(),
    userId,
    content,
    dueAt: dueAt || null,
    status: 'pending',
    sourceInteractionId: context?.socketId || '',
    createdAt: nowISO(),
    firedAt: null,
  };

  try {
    const db = readDB();
    if (!Array.isArray(db.reminders)) db.reminders = [];
    db.reminders.push(reminder);
    writeDB(db);

    const dueInfo = dueAt ? `，到期时间: ${dueAt}` : '（无截止时间）';
    logger.info(`[Reminder] 创建成功: ${content}${dueInfo}`);
    return `✅ 提醒已创建: "${content}"${dueInfo}\nID: ${reminder.id}`;
  } catch (e: any) {
    logger.error('[Reminder] 创建失败:', e.message);
    return `提醒创建失败: ${e.message}`;
  }
}

async function reminderList(args: Record<string, any>, context?: any): Promise<string> {
  const status = String(args.status || 'pending').trim();
  const userId = context?.userId || 'default';

  try {
    const db = readDB();
    const reminders = (db.reminders || [])
      .filter((r: any) => r.userId === userId && r.status === status)
      .sort((a: any, b: any) => {
        if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
        if (a.dueAt) return -1;
        if (b.dueAt) return 1;
        return b.createdAt.localeCompare(a.createdAt);
      });

    if (reminders.length === 0) {
      return status === 'pending'
        ? '📭 没有待处理的提醒。用 reminder_create 创建新提醒。'
        : `📭 没有状态为"${status}"的提醒。`;
    }

    const lines: string[] = [`📋 ${status === 'pending' ? '待处理' : status === 'done' ? '已完成' : status}提醒 (${reminders.length}条):`];
    for (const r of reminders) {
      const dueStr = r.dueAt ? ` ⏰ ${r.dueAt}` : '';
      const doneStr = r.firedAt ? ` ✅ 完成于 ${r.firedAt}` : '';
      lines.push(`  • [${r.id.slice(-8)}] ${r.content}${dueStr}${doneStr}`);
    }
    return lines.join('\n');
  } catch (e: any) {
    logger.error('[Reminder] 列表查询失败:', e.message);
    return `提醒列表查询失败: ${e.message}`;
  }
}

async function reminderDismiss(args: Record<string, any>, context?: any): Promise<string> {
  const id = String(args.id || '').trim();
  const userId = context?.userId || 'default';

  if (!id) throw new Error('id 参数不能为空（提醒ID）');

  try {
    const db = readDB();
    const reminders = db.reminders || [];
    const idx = reminders.findIndex((r: any) => r.id === id || r.id.endsWith(id));

    if (idx === -1) {
      return `❌ 未找到提醒: ${id}。用 reminder_list 查看所有提醒及ID。`;
    }

    const r = reminders[idx];
    if (r.userId !== userId) {
      return `❌ 无权操作此提醒（不属于当前用户）。`;
    }

    r.status = 'done';
    r.firedAt = nowISO();
    writeDB(db);

    logger.info(`[Reminder] 完成: ${r.content}`);
    return `✅ 提醒已完成: "${r.content}"`;
  } catch (e: any) {
    logger.error('[Reminder] 完成操作失败:', e.message);
    return `提醒操作失败: ${e.message}`;
  }
}

async function reminderDelete(args: Record<string, any>, context?: any): Promise<string> {
  const id = String(args.id || '').trim();
  const userId = context?.userId || 'default';

  if (!id) throw new Error('id 参数不能为空（提醒ID）');

  try {
    const db = readDB();
    const reminders = db.reminders || [];
    const idx = reminders.findIndex((r: any) => r.id === id || r.id.endsWith(id));

    if (idx === -1) {
      return `❌ 未找到提醒: ${id}。用 reminder_list 查看所有提醒及ID。`;
    }

    const r = reminders[idx];
    if (r.userId !== userId) {
      return `❌ 无权操作此提醒（不属于当前用户）。`;
    }

    reminders.splice(idx, 1);
    writeDB(db);

    logger.info(`[Reminder] 删除: ${r.content}`);
    return `🗑 提醒已删除: "${r.content}"`;
  } catch (e: any) {
    logger.error('[Reminder] 删除失败:', e.message);
    return `提醒删除失败: ${e.message}`;
  }
}

export function registerReminderTools(registry: ToolRegistry): void {
  registry.register({
    name: 'reminder_create',
    description:
      '创建日历提醒。支持设置截止时间（ISO 8601 格式，如 2026-07-29T09:00:00）。提醒会持久化存储，跨会话保留。创建后用 reminder_list 查看所有提醒。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '提醒内容，如"下午3点开会"、"明天交报告"' },
        dueAt: { type: 'string', description: '截止时间 — ISO 8601 格式，如 2026-07-29T09:00:00（可选）' },
      },
      required: ['content'],
    },
    handler: reminderCreate,
    permission: 'user',
    securityLevel: classifyBuiltinToolRisk('创建日历提醒。支持设置截止时间（ISO 8601 格式，如 2026-07-29T09:00:00）。提醒会持久化存储，跨会话保留。创建后用 reminder_list 查看所有提醒。'),
  });

  registry.register({
    name: 'reminder_list',
    description:
      '列出提醒。默认列出待处理(pending)的提醒，也可查看已完成(done)的提醒。返回提醒ID、内容和截止时间。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '提醒状态: "pending"（待处理，默认）或 "done"（已完成）' },
      },
      required: [],
    },
    handler: reminderList,
    permission: 'user',
    securityLevel: classifyBuiltinToolRisk('列出提醒。默认列出待处理(pending)的提醒，也可查看已完成(done)的提醒。返回提醒ID、内容和截止时间。'),
  });

  registry.register({
    name: 'reminder_dismiss',
    description: '将提醒标记为已完成。通过提醒ID（或ID后缀）来定位提醒。用 reminder_list 查看所有提醒及其ID。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提醒ID（完整ID或末尾8位后缀均可）' },
      },
      required: ['id'],
    },
    handler: reminderDismiss,
    permission: 'user',
    securityLevel: classifyBuiltinToolRisk('将提醒标记为已完成。通过提醒ID（或ID后缀）来定位提醒。用 reminder_list 查看所有提醒及其ID。'),
  });

  registry.register({
    name: 'reminder_delete',
    description: '删除提醒（永久移除）。与 reminder_dismiss 不同，这会彻底删除记录而非标记完成。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提醒ID（完整ID或末尾8位后缀均可）' },
      },
      required: ['id'],
    },
    handler: reminderDelete,
    permission: 'user',
    securityLevel: 'confirm',
  });
}
