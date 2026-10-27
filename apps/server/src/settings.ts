import fs from 'node:fs';
import path from 'node:path';
import type { Approver, NotifyEvent, Settings } from '@af/shared';
import { bus } from './bus.js';
import { company } from './company.js';
import { config } from './config.js';
import { db } from './db.js';
import { store } from './store.js';

/**
 * 公司规则：审批由谁来批、交付是否要老板验收、老板超时未处理怎么办、消息推送。
 * 老板在界面里修改，持久化在 data/settings.json。
 */

function splitIds(s: unknown): string[] {
  const arr = Array.isArray(s) ? s : String(s ?? '').split(/[\s,，;；]+/);
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, 50);
}

const FILE = path.join(config.dataDir, 'settings.json');
const NOTIFY_EVENTS: NotifyEvent[] = ['decision', 'acceptance', 'budget', 'goal_done', 'blocked'];

function defaults(): Settings {
  return {
    approval: { r1: 'manager', r2: 'human', humanAcceptance: true },
    timeout: { minutes: 0, toolAction: 'reject', questionAction: 'delegate' },
    notify: { webhook: process.env.NOTIFY_WEBHOOK || '', publicUrl: process.env.PUBLIC_URL || '', events: ['decision', 'acceptance', 'budget'] },
    im: { dingtalkAdmins: splitIds(process.env.DINGTALK_ADMINS) },
  };
}

class SettingsStore {
  private s: Settings = defaults();
  /** 还没保存过：交付验收沿用公司配置里的 requireHumanAcceptance */
  private fresh = true;
  private timer: NodeJS.Timeout | null = null;

  async load() {
    if (db.ready) {
      const fromDb = await db.getKv<Partial<Settings>>('settings');
      if (fromDb) {
        const d = defaults();
        this.s = {
          approval: { ...d.approval, ...fromDb.approval },
          timeout: { ...d.timeout, ...fromDb.timeout },
          notify: { ...d.notify, ...fromDb.notify },
          im: { ...d.im, ...fromDb.im },
        };
        this.fresh = false;
        return;
      }
    }
    if (!fs.existsSync(FILE)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<Settings>;
      const d = defaults();
      this.s = {
        approval: { ...d.approval, ...saved.approval },
        timeout: { ...d.timeout, ...saved.timeout },
        notify: { ...d.notify, ...saved.notify },
        im: { ...d.im, ...saved.im },
      };
      this.fresh = false;
      if (db.ready) db.setKv('settings', this.s);
    } catch (e) {
      console.error('加载 settings.json 失败', e);
    }
  }

  get(): Settings {
    if (this.fresh && company.profile) this.s.approval.humanAcceptance = company.profile.policy.requireHumanAcceptance;
    return this.s;
  }

  update(patch: { approval?: Partial<Settings['approval']>; timeout?: Partial<Settings['timeout']>; notify?: Partial<Settings['notify']>; im?: Partial<Settings['im']> }) {
    const cur = this.get();
    const a = patch.approval ?? {};
    const t = patch.timeout ?? {};
    const n = patch.notify ?? {};
    const approver = (v: unknown, ok: Approver[], d: Approver) => (ok.includes(v as Approver) ? (v as Approver) : d);
    this.s = {
      approval: {
        r1: approver(a.r1, ['auto', 'manager', 'human'], cur.approval.r1),
        r2: approver(a.r2, ['manager', 'human'], cur.approval.r2) as Settings['approval']['r2'],
        humanAcceptance: typeof a.humanAcceptance === 'boolean' ? a.humanAcceptance : cur.approval.humanAcceptance,
      },
      timeout: {
        minutes: typeof t.minutes === 'number' && t.minutes >= 0 && t.minutes <= 7 * 24 * 60 ? Math.round(t.minutes) : cur.timeout.minutes,
        toolAction: 'reject',
        questionAction: t.questionAction === 'wait' || t.questionAction === 'delegate' ? t.questionAction : cur.timeout.questionAction,
      },
      notify: {
        webhook: typeof n.webhook === 'string' ? n.webhook.trim() : cur.notify.webhook,
        publicUrl: typeof n.publicUrl === 'string' ? n.publicUrl.trim().replace(/\/+$/, '') : cur.notify.publicUrl,
        events: Array.isArray(n.events) ? NOTIFY_EVENTS.filter((e) => n.events!.includes(e)) : cur.notify.events,
      },
      im: { dingtalkAdmins: patch.im?.dingtalkAdmins !== undefined ? splitIds(patch.im.dingtalkAdmins) : cur.im.dingtalkAdmins },
    };
    if (this.s.notify.webhook && !/^https?:\/\//i.test(this.s.notify.webhook)) throw new Error('推送地址需要以 http:// 或 https:// 开头');
    this.fresh = false;
    db.setKv('settings', this.s);
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.s, null, 2));
    fs.renameSync(tmp, FILE);
    bus.emit({ t: 'settings', d: this.s });
    bus.log('info', '老板更新了公司规则');
    store.onChangeNotify();
    return this.s;
  }

  /** 每 30 秒检查一次老板超时未处理的事项 */
  startTimeouts() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), 30_000);
  }

  sweep(now = Date.now()) {
    const { minutes, questionAction } = this.get().timeout;
    if (!minutes) return;
    for (const a of store.approvals.values()) {
      // 预算请示和交付验收必须老板本人决定，不做超时处理
      if (a.status !== 'pending' || a.approver !== 'human' || a.budget || a.kind === 'acceptance') continue;
      if (now - a.createdAt < minutes * 60_000) continue;
      if (a.kind === 'tool') {
        a.autoDecided = true;
        store.decideApproval(a.id, false, 'system', `老板 ${minutes} 分钟未处理，按规则自动驳回，请换一种不需要该权限的做法，或稍后再申请`);
      } else if (a.kind === 'question' && questionAction === 'delegate') {
        // 返工超限的裁决涉及验收标准，仍然等老板
        const t = a.taskId ? store.tasks.get(a.taskId) : undefined;
        if (t?.status === 'awaiting_human') continue;
        a.autoDecided = true;
        store.decideApproval(a.id, true, 'system', `老板 ${minutes} 分钟未答复，授权你按最佳判断推进，并在交付总结里说明你的取舍`);
      }
    }
  }
}

export const settings = new SettingsStore();
