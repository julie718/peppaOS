/**
 * 统一工具确认流程 — 4 处 requestConfirmation（chat.ts×2 / task.ts / voice.ts）
 * 与 autonomous 后台执行器（task_executor.ts）共用的单一实现。
 *
 * 本次改造（见任务清单第 2/4 项）：
 *   1. 信任名单命中（tool_trust.ts：7 天有效期内且 denies===0）→ 自动放行；
 *   2. autonomous 模式下 low 风险只读工具（股票/天气查询等）自动放行，跳过确认弹窗；
 *   3. 弹窗下发后等待前端「弹窗已展示」回执（tool:confirm_shown:{cid}），
 *      收到回执才开始确认倒计时 —— 回执/结果均未到达则判定为弹窗投递失败；
 *   4. 风险分级超时：high 30s / medium 60s / low 90s；
 *   5. 三套故障文案（废除统一误导文本"工具响应超时，请稍后再试。"）：
 *      ② 用户确认等待超时：   "等待你的工具操作确认超时，本次调用已取消。"
 *      ③ 弹窗未送达（网络）： "网络通信异常，工具确认弹窗未能送达，本次调用取消。"
 *      ① 外部接口真超时由 registry.execute 超时 → friendlyErrors → chat.ts 兜底文案
 *        （"工具响应超时，请稍后再试。"）负责，不经过本模块。
 */
import { logger } from '../lib/logger';

export type ToolRisk = 'low' | 'medium' | 'high';

/** 风险分级超时（ms）：high 维持 30s；low 放宽到 90s；medium 取 60s 插值 */
export const CONFIRM_TIMEOUT_BY_RISK: Record<ToolRisk, number> = {
  high: 30_000,
  medium: 60_000,
  low: 90_000,
};

/** 弹窗「已展示」回执等待上限（ms）——超时判定为网络投递失败（故障③） */
export const CONFIRM_DELIVERY_TIMEOUT_MS = parseInt(process.env.CONFIRM_DELIVERY_TIMEOUT_MS || '10000', 10);

export const CONFIRM_FAILURE_TEXTS = {
  /** ② 用户确认等待超时（弹窗已展示但用户未在时限内操作） */
  userConfirmTimeout: '等待你的工具操作确认超时，本次调用已取消。',
  /** ③ 网络投递失败（弹窗未送达前端，无回执且无结果） */
  undelivered: '网络通信异常，工具确认弹窗未能送达，本次调用取消。',
} as const;

/** 与前端 ToolConfirmDialog.getToolRisk 保持一致的确定性风险分级（写文件按任务要求升为 high） */
export function classifyToolRisk(name: string, args: Record<string, any> = {}): ToolRisk {
  const normalized = (name || '').toLowerCase();
  const argText = JSON.stringify(args || {}).toLowerCase();
  const action = String(args?.action || '').trim();
  const mode = String(args?.mode || '').trim();
  // 敏感 client_action（会议/自主模式切换/壁纸模式）
  const sensitiveClientAction =
    action === 'start_meeting_mode' || action === 'end_meeting_mode' || action === 'set_wallpaper_mode' ||
    ((action === 'set_mode' || action === 'set_client_mode') && (mode === 'meeting' || mode === 'autonomous'));
  if (sensitiveClientAction) return 'high';
  // 删除/卸载/危险指令（删文件、rm、uninstall 等）
  if (normalized.includes('delete') || normalized.includes('remove') || normalized.includes('rm') || normalized.includes('uninstall')) return 'high';
  if (/\b(rm\s+-rf|format\b|shutdown\b|reboot\b|reg\s+delete|drop\s+table|delete\s+from)\b/i.test(argText)) return 'high';
  // shell 执行（终端/命令/桌面自动化）
  if (normalized === 'computer_use' || normalized.includes('run_command') || normalized.includes('terminal') || normalized.includes('shell')) return 'high';
  // 写文件（任务要求：写文件属高风险操作，强制确认）
  if (normalized.includes('write') || normalized.includes('append_file') || normalized.includes('edit_file')) return 'high';
  // 中风险：消息/桌面控制/发布安装
  if (normalized.includes('wechat') || normalized.includes('message') || normalized.includes('desktop_') || normalized.includes('mouse') || normalized.includes('keyboard')) return 'medium';
  if (normalized.includes('save') || normalized.includes('publish') || normalized.includes('install')) return 'medium';
  return 'low';
}

/** 确认通道抽象：socket 与 Socket.IO server（后台执行器 io.to(room)）两种接线方式 */
export interface ConfirmChannel {
  emit(event: string, payload: any): void;
  /** 一次性监听；返回取消监听函数（settle 后清理） */
  once(event: string, cb: (data: any) => void): () => void;
}

export interface RequestToolConfirmationOptions {
  uid: string;
  toolName: string;
  args: Record<string, any>;
  channel: ConfirmChannel;
  /** true = autonomous 模式：low 风险只读工具自动放行 */
  autonomous?: boolean;
  /** agent:tool_call 结果上报（可选：后台执行器无前端 tool 卡时省略） */
  emitToolCall?: (payload: Record<string, any>) => void;
  /** 信任达成/恢复时通知上层（socket 场景发 agent:notification + pushNotification） */
  onTrustPromoted?: (toolName: string) => void;
  /** 弹窗回执等待超时（默认 CONFIRM_DELIVERY_TIMEOUT_MS） */
  deliveryTimeoutMs?: number;
}

/**
 * 确认流程（Promise<boolean>：true=放行，false=拒绝/超时/未送达）：
 *   信任名单 → autonomous low 风险自动放行 → 弹窗流（回执→分级倒计时→结果）
 */
export async function requestToolConfirmation(opts: RequestToolConfirmationOptions): Promise<boolean> {
  const { uid, toolName, args, channel, autonomous } = opts;
  const emitToolCall = opts.emitToolCall || (() => {});
  const { getTrustedTools, recordToolApprove, recordToolDeny } = await import('./tool_trust');

  // 1. 信任名单命中（7 天有效期内且 denies===0）→ 自动放行
  if (getTrustedTools(uid).includes(toolName)) {
    emitToolCall({ name: toolName, arguments: args, result: 'Auto-approved (trusted)', error: undefined });
    return true;
  }

  // 2. autonomous 模式 + low 风险只读工具 → 自动放行，跳过确认弹窗
  const risk = classifyToolRisk(toolName, args);
  if (autonomous && risk === 'low') {
    logger.info(`[ConfirmFlow] autonomous 模式 low 风险工具自动放行: ${toolName}`);
    emitToolCall({ name: toolName, arguments: args, result: 'Auto-approved (autonomous low-risk)', error: undefined });
    return true;
  }

  // 3. 弹窗确认流：下发 → 等「弹窗已展示」回执 → 按风险分级倒计时 → 用户结果
  logger.info(`[ConfirmFlow] 确认弹窗: ${toolName} (risk=${risk}, ${autonomous ? 'autonomous' : 'interactive'})`);
  return new Promise<boolean>((resolve) => {
    const cid = crypto.randomUUID();
    const resultEvent = `tool:confirm_result:${cid}`;
    const shownEvent = `tool:confirm_shown:${cid}`;
    let settled = false;
    const offs: Array<() => void> = [];
    let deliveryTimer: ReturnType<typeof setTimeout> | null = null;
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      offs.forEach((off) => { try { off(); } catch {} });
      if (deliveryTimer) { clearTimeout(deliveryTimer); deliveryTimer = null; }
      if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    };
    const finish = (allowed: boolean, failText?: string) => {
      if (settled) return;
      settled = true;
      if (failText) {
        emitToolCall({ name: toolName, arguments: args, result: failText, error: failText });
      }
      cleanup();
      resolve(allowed);
    };

    // 回执：前端弹窗已展示 → 才开始确认倒计时（按风险分级超时）
    offs.push(channel.once(shownEvent, () => {
      if (settled) return;
      if (deliveryTimer) { clearTimeout(deliveryTimer); deliveryTimer = null; }
      const timeoutMs = CONFIRM_TIMEOUT_BY_RISK[risk];
      confirmTimer = setTimeout(() => {
        // ② 用户确认等待超时
        logger.warn(`[ConfirmFlow] 确认超时（${timeoutMs}ms）: ${toolName}`);
        finish(false, CONFIRM_FAILURE_TEXTS.userConfirmTimeout);
      }, timeoutMs);
      logger.info(`[ConfirmFlow] 弹窗已展示回执: ${toolName} (${risk}, 确认时限 ${timeoutMs / 1000}s)`);
    }));

    // 用户结果：批准 → 记录信任（达阈值晋升/拒绝挂起后恢复）；拒绝 → 记 deny（denies>0 强制弹窗）
    offs.push(channel.once(resultEvent, (data: { allowed: boolean }) => {
      if (data.allowed === true) {
        const promoted = recordToolApprove(uid, toolName);
        if (promoted) opts.onTrustPromoted?.(toolName);
      } else {
        recordToolDeny(uid, toolName);
      }
      finish(data.allowed === true);
    }));

    // 先挂监听再下发，避免丢事件
    channel.emit('agent:confirm_tool', { correlationId: cid, name: toolName, arguments: args });

    // 回执与结果均未到达 → ③ 弹窗未送达（网络通信异常）
    deliveryTimer = setTimeout(() => {
      if (settled) return;
      logger.warn(`[ConfirmFlow] 弹窗回执未到达（${(opts.deliveryTimeoutMs || CONFIRM_DELIVERY_TIMEOUT_MS) / 1000}s）: ${toolName}`);
      finish(false, CONFIRM_FAILURE_TEXTS.undelivered);
    }, opts.deliveryTimeoutMs || CONFIRM_DELIVERY_TIMEOUT_MS);
  });
}
