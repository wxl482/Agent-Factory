import type { NotifyEvent, ServerMsg } from '@af/shared';
import { bus } from './bus.js';
import { company } from './company.js';
import { settings } from './settings.js';
import { imRegistry } from './im/index.js';

/**
 * 外部推送：需要老板决策、待验收、超预算、目标完成等事件推到群机器人。
 * 按地址自动识别飞书 / 企业微信 / 钉钉，其他地址收到通用 JSON：{ event, title, text, url }。
 * 注意：开启了「签名校验」的机器人不支持，请用「关键词」或「IP 白名单」方式（关键词填 Agent Factory）。
 */

type Flavor = 'feishu' | 'wecom' | 'dingtalk' | 'generic';

function flavorOf(url: string): Flavor {
  if (/open\.(feishu\.cn|larksuite\.com)/.test(url)) return 'feishu';
  if (/qyapi\.weixin\.qq\.com/.test(url)) return 'wecom';
  if (/oapi\.dingtalk\.com/.test(url)) return 'dingtalk';
  return 'generic';
}

function body(flavor: Flavor, event: NotifyEvent | 'test', title: string, text: string, url: string) {
  const content = `【Agent Factory】${title}\n${text}${url ? `\n👉 ${url}` : ''}`.trim();
  switch (flavor) {
    case 'feishu':
      return { msg_type: 'text', content: { text: content } };
    case 'wecom':
    case 'dingtalk':
      return { msgtype: 'text', text: { content } };
    default:
      return { event, title, text, url };
  }
}

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s);

class Notifier {
  /** 已推送过的事件（审批 id / 目标 id + 状态），避免重复推送 */
  private sent = new Set<string>();

  start() {
    bus.on((m) => this.onMsg(m));
  }

  private onMsg(m: ServerMsg) {
    if (m.t === 'approval') {
      const a = m.d;
      if (a.status !== 'pending' || a.approver !== 'human') return;
      const event: NotifyEvent = a.budget ? 'budget' : a.kind === 'acceptance' ? 'acceptance' : 'decision';
      const head = a.budget ? '💰 预算告警' : a.kind === 'acceptance' ? '📦 交付待验收' : '🙋 需要你决策';
      this.push(`approval:${a.id}`, event, `${head}：${a.title}`, `${a.risk} · 来自 ${company.agentName(a.requesterId)}\n${clip(a.detail)}`, a.id);
    } else if (m.t === 'task') {
      const t = m.d;
      if (t.kind === 'goal' && t.status === 'done') this.push(`done:${t.id}`, 'goal_done', `✅ 目标完成：${t.title}`, clip(t.result));
      if (t.kind === 'task' && t.status === 'blocked') this.push(`blocked:${t.id}:${t.updatedAt}`, 'blocked', `⛔ 任务受阻：${t.title}`, clip(t.result || t.feedback));
    }
  }

  private push(key: string, event: NotifyEvent, title: string, text: string, approvalId?: string) {
    const { webhook, events } = settings.get().notify;
    if (!events.includes(event) || this.sent.has(key)) return;
    if (!webhook && !imRegistry.hasEnabled) return;
    this.sent.add(key);
    if (this.sent.size > 5000) this.sent = new Set([...this.sent].slice(-2000));
    if (webhook) this.send(event, title, text).catch((e) => bus.log('warn', `消息推送失败：${e?.message ?? e}`));
    // IM 机器人通道：推到管理员单聊，可以直接回复指令处理
    if (imRegistry.hasEnabled) {
      const { publicUrl } = settings.get().notify;
      const how = approvalId
        ? `\n\n回复「批准 ${approvalId} 备注」或「驳回 ${approvalId} 原因」，发「详情 ${approvalId}」或「交付」直接看完整成稿`
        : '\n\n发「交付」可直接查看完整成稿全文';
      const md = `**${title}**\n\n${text.replace(/\n/g, '\n\n')}${how}${publicUrl ? `\n\n[打开 Agent Factory](${publicUrl})` : ''}`;
      imRegistry.notifyAdmins(title.slice(0, 60), md).catch((e) => bus.log('warn', `IM 单聊推送失败：${e?.message ?? e}`));
    }
  }

  async test() {
    const hasWebhook = !!settings.get().notify.webhook;
    const hasIm = imRegistry.hasEnabled && settings.get().im.dingtalkAdmins.length > 0;
    if (!hasWebhook && !hasIm) throw new Error('还没有填写推送地址，也没有配置聊天机器人管理员');
    const text = '收到这条消息说明配置成功。之后需要你决策、交付待验收、超预算时会推送到这里。';
    if (hasWebhook) await this.send('test', '推送测试', text);
    if (hasIm) await imRegistry.notifyAdmins('推送测试', `**【Agent Factory】推送测试**\n\n${text}\n\n在这里直接回复指令即可，发「帮助」查看用法。`);
  }

  private async send(event: NotifyEvent | 'test', title: string, text: string) {
    const { webhook, publicUrl } = settings.get().notify;
    const flavor = flavorOf(webhook);
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body(flavor, event, title, text, publicUrl)),
      signal: AbortSignal.timeout(8000),
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status} ${clip(raw, 120)}`);
    // 机器人接口出错时 HTTP 也是 200，要看返回体里的错误码
    try {
      const j = JSON.parse(raw);
      const code = j.code ?? j.errcode ?? j.StatusCode ?? 0;
      if (code !== 0) throw new Error(`${code} ${j.msg ?? j.errmsg ?? j.StatusMessage ?? ''}`.trim());
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
}

export const notifier = new Notifier();
