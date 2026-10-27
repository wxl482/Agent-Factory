import { DWClient, EventAck, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';
import type { ImStatus } from '@af/shared';
import { bus } from '../bus.js';
import { settings } from '../settings.js';
import { handle, type Reply } from './commands.js';

/**
 * 钉钉企业内部应用机器人（Stream 模式）。
 * - 我们主动连钉钉的长连接收消息，不需要公网地址，本机也能跑
 * - 群里 @ 机器人 / 单聊发消息 → commands.handle() → 通过消息里的 sessionWebhook 回复
 * - 需要老板处理的事：用「批量发送单聊消息」接口推给管理员
 * 配置：.env 里 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET（应用的 AppKey / AppSecret）
 */

const API = (process.env.DINGTALK_API_BASE || 'https://api.dingtalk.com').replace(/\/+$/, '');

interface RobotMsg {
  msgId: string;
  msgtype: string;
  text?: { content: string };
  senderStaffId?: string;
  senderId: string;
  senderNick: string;
  conversationType: string; // '1' 单聊 / '2' 群聊
  conversationTitle?: string;
  sessionWebhook: string;
  sessionWebhookExpiredTime: number;
  robotCode?: string;
}

class DingTalk {
  private client: DWClient | null = null;
  status: ImStatus['dingtalk'] = { state: 'off' };
  private seen = new Map<string, number>();
  private token: { value: string; exp: number } | null = null;
  private robotCode = '';

  /** 已配置且凭证有效（凭证错误时不再尝试推送，避免刷屏告警） */
  get enabled() {
    return !!this.client && this.status.state !== 'error';
  }

  start() {
    const clientId = process.env.DINGTALK_CLIENT_ID?.trim();
    const clientSecret = process.env.DINGTALK_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return;
    this.robotCode = process.env.DINGTALK_ROBOT_CODE?.trim() || clientId;
    this.client = new DWClient({ clientId, clientSecret, keepAlive: true });
    this.client.registerCallbackListener(TOPIC_ROBOT, (res) => void this.onMessage(res));
    // SDK 默认订阅了所有事件推送（EVENT *），没注册处理函数时收到事件会抛错；这里统一确认
    this.client.registerAllEventListener((msg) => {
      bus.log('debug', `钉钉事件：${msg.headers.eventType ?? msg.headers.topic}`);
      return { status: EventAck.SUCCESS };
    });
    // 排查用：记录钉钉推下来的每一帧（类型 / topic），收不到消息时看日志就知道是没推过来还是处理出错
    const c = this.client;
    const down = c.onDownStream.bind(c);
    c.onDownStream = (data: string) => {
      try {
        const m = JSON.parse(data);
        if (m.headers?.topic !== 'ping') bus.log('debug', `钉钉下行：${m.type} ${m.headers?.topic ?? ''}`);
      } catch {}
      try {
        down(data);
      } catch (e) {
        bus.log('error', `钉钉消息处理出错：${errText(e)}`);
      }
    };
    this.setStatus({ state: 'connecting' });
    void this.boot();
  }

  /** 先用 AppKey/AppSecret 换一次 token 校验凭证，再建长连接；connect() 失败时 SDK 只会默默重试，不会报错 */
  private async boot() {
    try {
      await this.accessToken();
    } catch (e) {
      this.setStatus({ state: 'error', detail: `凭证无效：${errText(e)}` });
      return;
    }
    this.client!.connect().catch((e) => this.setStatus({ state: 'error', detail: errText(e) }));
    // SDK 不发连接事件，定时看连接状态（断线后 SDK 会自动重连）
    setInterval(() => {
      const c = this.client!;
      if (c.connected && this.status.state !== 'online') this.setStatus({ state: 'online' });
      else if (!c.connected && this.status.state === 'online') this.setStatus({ state: 'connecting', detail: '断线重连中' });
    }, 3000).unref();
  }

  private setStatus(s: ImStatus['dingtalk']) {
    const changed = s.state !== this.status.state;
    this.status = s;
    bus.emit({ t: 'im', d: { dingtalk: s } });
    if (!changed) return;
    if (s.state === 'online') bus.log('success', '钉钉机器人已连接（Stream 模式）');
    if (s.state === 'error') bus.log('error', `钉钉机器人连接失败：${s.detail ?? ''}，请检查 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET 和应用是否开启了 Stream 模式`);
  }

  private async onMessage(res: DWClientDownStream) {
    // 先确认收到，避免钉钉 60 秒后重推
    try {
      this.client!.socketCallBackResponse(res.headers.messageId, { status: 'SUCCESS' });
    } catch {}
    let m: RobotMsg;
    try {
      m = JSON.parse(res.data);
    } catch (e) {
      bus.log('warn', `钉钉机器人消息解析失败：${String(res.data).slice(0, 200)}`);
      return;
    }
    if (this.dup(m.msgId || res.headers.messageId)) return;

    const id = m.senderStaffId || m.senderId;
    const who = { id, name: m.senderNick || id, admin: settings.get().im.dingtalkAdmins.includes(id), platform: '钉钉' };
    const text = m.msgtype === 'text' ? (m.text?.content ?? '') : '';
    bus.log('info', `钉钉${m.conversationType === '2' ? `群「${m.conversationTitle ?? ''}」` : '单聊'}收到 ${who.name}：${text.slice(0, 80) || `[${m.msgtype}]`}`);
    let reply: Reply;
    try {
      reply = m.msgtype === 'text' ? await handle(text, who) : { title: '提示', text: '暂时只支持文字指令，发「帮助」查看用法。' };
    } catch (e) {
      bus.log('error', `钉钉指令处理出错：${errText(e)}`);
      reply = { title: '出错了', text: `处理出错：${errText(e)}` };
    }
    try {
      await this.replyTo(m, reply);
    } catch (e) {
      bus.log('warn', `钉钉回复失败：${errText(e)}`);
    }
  }

  /** 钉钉可能重推同一条消息，按 msgId 去重（保留 10 分钟） */
  private dup(id: string) {
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 600_000) this.seen.delete(k);
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }

  private async replyTo(m: RobotMsg, reply: Reply) {
    if (Date.now() > m.sessionWebhookExpiredTime) throw new Error('sessionWebhook 已过期');
    await this.post(m.sessionWebhook, { msgtype: 'markdown', markdown: { title: reply.title, text: reply.text } });
  }

  /** 推送给所有管理员的单聊（需要老板处理的事） */
  async notifyAdmins(title: string, text: string) {
    const userIds = settings.get().im.dingtalkAdmins;
    if (!this.client || !userIds.length) return;
    // 单次最多 20 人
    for (let i = 0; i < userIds.length; i += 20) {
      await this.post(`${API}/v1.0/robot/oToMessages/batchSend`, {
        robotCode: this.robotCode,
        userIds: userIds.slice(i, i + 20),
        msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title, text }),
      });
    }
  }

  private async accessToken() {
    if (this.token && Date.now() < this.token.exp) return this.token.value;
    const value = await this.client!.getAccessToken();
    // 官方有效期 2 小时，提前刷新
    this.token = { value, exp: Date.now() + 90 * 60_000 };
    return value;
  }

  private async post(url: string, body: unknown) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': await this.accessToken() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status} ${raw.slice(0, 200)}`);
    try {
      const j = JSON.parse(raw);
      if (j.errcode && j.errcode !== 0) throw new Error(`${j.errcode} ${j.errmsg ?? ''}`);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
}

function errText(e: any) {
  return e?.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : (e?.message ?? String(e));
}

export const dingtalk = new DingTalk();
