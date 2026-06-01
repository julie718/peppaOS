/**
 * WeChat ClawBot Adapter — 腾讯官方个人号 Bot API (iLink 协议)
 *
 * 接入方式：
 *   1. Lumi Settings → Messaging → WeChat 页签 → 点「获取二维码」
 *   2. 手机微信扫描二维码 → 确认登录
 *   3. Lumi 自动开始接收和回复微信消息
 *
 * 不需要企业注册、不需要域名、不需要 Webhook 回调。
 * 基于腾讯 ilinkai.weixin.qq.com 的官方开放的个人 Bot API。
 */

import crypto from 'crypto';
import type {
  MessageAdapter,
  IncomingMessage,
  OutgoingMessage,
  CardPayload,
  MessagingPlatform,
} from './types';

export interface WeChatClawBotConfig {
  botToken: string;
  botId: string;         // bot user ID (xxx@im.bot)
  baseUrl: string;       // returned by QR login, typically https://ilinkai.weixin.qq.com
  enabled: boolean;
}

// ── API types ──

interface QRCodeResponse {
  qrcode: string;  // base64 PNG
  qrcode_id: string;
  expires_in: number;
}

interface QRCodeStatusResponse {
  status: 'pending' | 'scanned' | 'confirmed' | 'expired';
  bot_token?: string;
  bot_id?: string;
  baseurl?: string;
  extra_info?: string;
}

interface WeixinMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  message_state: number;
  context_token: string;
  item_list: Array<{
    type: number;
    text_item?: { text: string };
  }>;
}

interface GetUpdatesResponse {
  ok: boolean;
  messages?: WeixinMessage[];
  get_updates_buf?: string;
}

// ── Adapter ──

export class WeChatClawBotAdapter implements MessageAdapter {
  readonly platform: MessagingPlatform = 'wechat';
  private config: WeChatClawBotConfig;
  private cursor: string = '';  // get_updates_buf
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: ((msg: IncomingMessage) => Promise<OutgoingMessage | null>) | null = null;

  constructor(config: WeChatClawBotConfig) {
    this.config = config;
  }

  reload(config: WeChatClawBotConfig): void {
    this.config = config;
  }

  // ── Auth: get QR code for login ──

  async getQRCode(): Promise<QRCodeResponse> {
    const res = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
    const data = await res.json();
    if (!data.qrcode) throw new Error(`QR code fetch failed: ${JSON.stringify(data)}`);
    return { qrcode: data.qrcode, qrcode_id: data.qrcode_id || data.qrcode, expires_in: data.expires_in || 300 };
  }

  async checkQRCodeStatus(qrcodeId: string): Promise<QRCodeStatusResponse> {
    const res = await fetch(`https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`);
    const data = await res.json();
    return {
      status: data.status || (data.bot_token ? 'confirmed' : 'pending'),
      bot_token: data.bot_token,
      bot_id: data.bot_id,
      baseurl: data.baseurl || 'https://ilinkai.weixin.qq.com',
      extra_info: data.extra_info,
    };
  }

  // ── Messaging: long-poll for new messages ──

  /** Start long-polling loop. Calls onMessage callback for each incoming message. */
  startPolling(onMessage: (msg: IncomingMessage) => Promise<OutgoingMessage | null>): void {
    this.onMessage = onMessage;
    if (this.pollingTimer) return;

    const poll = async () => {
      try {
        const uin = crypto.randomInt(0, 4294967295).toString();
        const uinB64 = Buffer.from(uin).toString('base64');

        const body: any = {};
        if (this.cursor) body.get_updates_buf = this.cursor;

        const res = await fetch(`${this.config.baseUrl || 'https://ilinkai.weixin.qq.com'}/ilink/bot/getupdates`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'AuthorizationType': 'ilink_bot_token',
            'X-WECHAT-UIN': uinB64,
            'Authorization': `Bearer ${this.config.botToken}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(40_000), // 35s hold + 5s margin
        });

        const data: GetUpdatesResponse = await res.json();
        if (data.get_updates_buf) this.cursor = data.get_updates_buf;

        if (data.messages && data.messages.length > 0) {
          for (const msg of data.messages) {
            const parsed = this.parseEvent(msg);
            if (parsed && this.onMessage) {
              const reply = await this.onMessage(parsed);
              if (reply) await this.sendMessage(parsed.userId, reply);
            }
          }
        }
      } catch (err: any) {
        // Long-poll timeout (AbortError) is expected — restart immediately
        if (err.name !== 'AbortError' && err.name !== 'TimeoutError') {
          console.error('[WeChat] Poll error:', err.message);
          // Brief backoff on unexpected errors
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    };

    this.pollingTimer = setInterval(() => poll(), 100); // fire every 100ms; poll() blocks internally
    poll(); // fire first one immediately
  }

  /** Stop long-polling loop */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  // ── Event Parsing ──

  parseEvent(event: any): IncomingMessage | null {
    const msg: WeixinMessage = event;

    if (!msg.from_user_id || msg.message_type !== 1) return null; // text only
    const textItem = msg.item_list?.find(i => i.type === 1)?.text_item;
    if (!textItem?.text) return null;

    return {
      platform: 'wechat',
      userId: msg.from_user_id,
      userName: msg.from_user_id,
      chatId: msg.from_user_id, // for now 1:1
      chatType: 'private',
      messageId: crypto.randomUUID(),
      text: textItem.text,
      raw: { context_token: msg.context_token, message: msg },
      timestamp: new Date().toISOString(),
    };
  }

  // ── Send Message ──

  async sendMessage(toUser: string, message: OutgoingMessage): Promise<string> {
    // toUser is the user_id from the incoming message (e.g. xxx@im.wechat)
    const contextToken = (message as any).context_token || '';

    const uin = crypto.randomInt(0, 4294967295).toString();
    const uinB64 = Buffer.from(uin).toString('base64');

    const body: any = {
      to_user_id: toUser,
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: message.text } }],
    };
    if (contextToken) body.context_token = contextToken;

    const url = `${this.config.baseUrl || 'https://ilinkai.weixin.qq.com'}/ilink/bot/sendmessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'X-WECHAT-UIN': uinB64,
        'Authorization': `Bearer ${this.config.botToken}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!data.ok && data.ok !== undefined) {
      console.error('[WeChat] Send error:', data);
      throw new Error(`WeChat send failed: ${JSON.stringify(data)}`);
    }
    return data.message_id || crypto.randomUUID();
  }

  async sendCard(_chatId: string, _card: CardPayload): Promise<string> {
    // WeChat iLink doesn't support cards yet — fall back to inline text
    return '';
  }

  getLoginQRUrl(): string {
    return '/api/wechat/qrcode';
  }
}

// ── Static helpers ──

export function createWeChatAdapter(config: WeChatClawBotConfig): WeChatClawBotAdapter {
  return new WeChatClawBotAdapter(config);
}
