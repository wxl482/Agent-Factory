import fs from 'node:fs';
import path from 'node:path';
import { PRIORITY_ORDER, type Approval, type Priority, type Task } from '@af/shared';
import { bus } from '../bus.js';
import { company } from '../company.js';
import { config } from '../config.js';
import { factory } from '../factory.js';
import { store } from '../store.js';
import { fmt, usage } from '../usage.js';
import * as wf from '../workflow.js';

/**
 * 聊天指令：与平台无关。钉钉 / 飞书等适配器把「谁说了什么」交给 handle()，拿回一段 Markdown 回复。
 * 查询类指令所有人可用；派活、审批、暂停、插话只有管理员（老板）能用。
 */

export interface Sender {
  /** 平台内的用户 id（钉钉 staffId） */
  id: string;
  name: string;
  /** 是否在管理员名单里 */
  admin: boolean;
  /** 平台名，用于日志 */
  platform: string;
}

export interface Reply {
  title: string;
  text: string;
}

interface Command {
  names: string[];
  usage: string;
  desc: string;
  admin?: boolean;
  run(arg: string, who: Sender): Reply | Promise<Reply>;
}

const STATUS_CN: Record<string, string> = { idle: '空闲', thinking: '思考中', working: '工作中', waiting: '等审批', paused: '暂停', error: '出错' };
const TASK_CN: Record<string, string> = { planning: '规划中', todo: '待办', in_progress: '进行中', review: '待评审', changes_requested: '返工中', blocked: '受阻', awaiting_human: '等你验收', done: '完成', cancelled: '已取消' };

const r = (title: string, text: string): Reply => ({ title, text });

function pendingForBoss() {
  return [...store.approvals.values()].filter((a) => a.status === 'pending' && a.approver === 'human').sort((a, b) => a.createdAt - b.createdAt);
}

function describeApproval(a: Approval) {
  const kind = a.budget ? '预算' : a.kind === 'acceptance' ? '验收' : a.kind === 'question' ? '请示' : '操作';
  return `**${a.id}** [${a.risk}·${kind}] ${a.title}`;
}

/** 提取目标或任务关联的 Markdown/文本产出内容，方便在钉钉里直接查看和复制 */
function readGoalDeliverableText(taskOrGoalId: string | null): string {
  if (!taskOrGoalId) return '';
  const t = store.tasks.get(taskOrGoalId);
  if (!t) return '';
  const goal = t.kind === 'goal' ? t : t.parentId ? store.tasks.get(t.parentId) : undefined;
  const allTasks = goal ? [goal, ...store.children(goal.id)] : [t];
  const artifacts = [...new Set(allTasks.flatMap((x) => x.artifacts))].filter((p) => !/^(\.tmp|node_modules|\.git)(\/|-|$)/.test(p));
  if (!artifacts.length) return '';
  const mdFiles = artifacts.filter((p) => /\.(md|txt)$/i.test(p));
  const out: string[] = [`\n\n---\n📄 **产出文件**：${artifacts.map((p) => `\`${p}\``).join('、')}`];
  for (const relPath of mdFiles.slice(0, 2)) {
    try {
      const content = fs.readFileSync(path.join(config.workspace, relPath), 'utf8').trim();
      if (content) {
        out.push(`\n\n#### 📝 ${relPath}\n\n${content.slice(0, 2500)}${content.length > 2500 ? '\n...(已截断)' : ''}`);
      }
    } catch {}
  }
  return out.join('');
}

function formatGoalDelivery(g: Task): Reply {
  const kids = store.children(g.id);
  const done = kids.filter((k) => k.status === 'done').length;
  const cost = usage.stats().byGoal[g.id]?.cost ?? 0;
  const summary = g.result || kids.map((k) => k.result).filter(Boolean).join('\n\n') || '（暂无交付总结）';
  const body = readGoalDeliverableText(g.id);
  return r(
    `交付成果 ${g.id}`,
    `**${g.id}** [${g.priority}] ${g.title}\n状态：${TASK_CN[g.status] ?? g.status}（子任务 ${done}/${kids.length} · 花费 ${fmt(cost)}）\n\n${summary.slice(0, 1000)}${body}`,
  );
}

/** 根据 id（大小写不敏感，可省略 A- 前缀）找待处理事项；只有一条时可以不写 id */
function findApproval(idArg: string, allowDecided = false): Approval | string {
  const list = pendingForBoss();
  if (!idArg) {
    if (!list.length) return '现在没有等你处理的事项。发「交付」可查看最近目标的产出成果。';
    return list.length === 1 ? list[0] : `有 ${list.length} 件待处理，请带上编号，例如「批准 ${list[0].id}」。发「待办」查看列表。`;
  }
  const want = idArg.toUpperCase().replace(/^A-?/, '');
  const pool = allowDecided ? [...store.approvals.values()] : list;
  const a = pool.find((x) => x.id.toUpperCase().replace(/^A-/, '') === want);
  return a ?? `没找到事项 ${idArg}。发「待办」查看待处理列表，或发「交付」查看最近目标成果。`;
}

function agentByName(name: string) {
  const n = name.trim();
  return company.profile.agents.find((a) => a.name === n || a.id === n || company.roleName(a.roleId) === n);
}

const COMMANDS: Command[] = [
  {
    names: ['帮助', 'help', '?', '？'],
    usage: '帮助',
    desc: '查看所有指令',
    run: (_arg, who) => r('指令列表', helpText(who)),
  },
  {
    names: ['我是谁', 'whoami', 'id'],
    usage: '我是谁',
    desc: '查看你的用户 id（用于设置管理员）',
    run: (_arg, who) =>
      r('我是谁', `你是 **${who.name}**，${who.platform} userId：\`${who.id}\`\n\n${who.admin ? '你是管理员，可以使用全部指令。' : '你还不是管理员。把这个 userId 填到 Agent Factory「规则 → 聊天机器人 → 管理员」里即可派活和审批。'}`),
  },
  {
    names: ['状态', 'status', '进度'],
    usage: '状态',
    desc: '谁在忙什么、进行中的目标、今日花费',
    run: () => {
      const agents = [...store.agents.values()];
      const lines = agents.map((a) => {
        const t = a.currentTaskId ? store.tasks.get(a.currentTaskId) : undefined;
        return `- **${a.name}**（${company.roleName(a.roleId)}）${STATUS_CN[a.status] ?? a.status}${t ? `：${t.title}` : a.activity && a.activity !== '空闲' ? `：${a.activity}` : ''}`;
      });
      const goals = [...store.tasks.values()].filter((t) => t.kind === 'goal' && t.status !== 'done' && t.status !== 'cancelled').sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
      const goalLines = goals.map((g) => {
        const kids = store.children(g.id);
        const done = kids.filter((k) => k.status === 'done').length;
        return `- [${g.priority}] ${g.title}（${TASK_CN[g.status]}${kids.length ? ` ${done}/${kids.length}` : ''}）`;
      });
      const s = usage.stats();
      const pending = pendingForBoss().length;
      return r(
        '公司状态',
        `#### 员工\n${lines.join('\n')}\n\n#### 进行中的目标\n${goalLines.join('\n') || '暂无'}\n\n今日花费 ${fmt(s.byDay[s.today]?.cost ?? 0)}${store.globalPaused ? ' · **全公司已暂停**' : ''}${pending ? ` · **${pending} 件事等你处理**（发「待办」查看）` : ''}`,
      );
    },
  },
  {
    names: ['待办', '待处理', 'todo'],
    usage: '待办',
    desc: '等你决策的事项',
    run: () => {
      const list = pendingForBoss();
      if (!list.length) return r('待办', '现在没有等你处理的事项 ✅');
      return r('待办', `${list.map((a) => `- ${describeApproval(a)}`).join('\n')}\n\n回复「批准 编号 [备注]」或「驳回 编号 原因」；发「详情 编号」看完整内容。`);
    },
  },
  {
    names: ['详情', 'detail'],
    usage: '详情 [编号]',
    desc: '查看某件待办/已处理事项或目标的完整内容与产出成稿',
    run: (arg) => {
      const clean = arg.trim();
      if (/^[GT]-/i.test(clean)) {
        const t = [...store.tasks.values()].find((x) => x.id.toUpperCase() === clean.toUpperCase());
        if (!t) return r('详情', `没找到目标或任务 ${clean}`);
        return formatGoalDelivery(t.kind === 'goal' ? t : (t.parentId ? store.tasks.get(t.parentId) : undefined) ?? t);
      }
      const a = findApproval(clean, true);
      if (typeof a === 'string') return r('详情', a);
      const stateStr = a.status === 'pending' ? '⏳ 待处理' : a.status === 'approved' ? '✅ 已批准' : '❌ 已驳回';
      const opts = a.options?.length ? `\n\n可选：${a.options.join(' / ')}` : '';
      const deliverable = a.kind === 'acceptance' ? readGoalDeliverableText(a.taskId) : '';
      return r(a.id, `${describeApproval(a)}（${stateStr}）\n\n来自 ${company.agentName(a.requesterId)}\n\n${a.detail.slice(0, 1200)}${opts}${deliverable}`);
    },
  },
  {
    names: ['交付', '成果', '文稿', 'delivery'],
    usage: '交付 [目标编号]',
    desc: '直接查看最近一个目标（或指定目标）的交付总结与成稿全文',
    run: (arg) => {
      const goals = [...store.tasks.values()].filter((t) => t.kind === 'goal').sort((a, b) => b.createdAt - a.createdAt);
      if (!goals.length) return r('交付成果', '还没有任何目标记录。');
      const want = arg.trim().toUpperCase();
      const g = want ? goals.find((x) => x.id.toUpperCase() === want || x.id.toUpperCase().replace(/^G-/, '') === want.replace(/^G-?/, '')) : goals[0];
      if (!g) return r('交付成果', `没找到目标 ${arg}。最近的目标是 ${goals[0].id}（${goals[0].title}）。`);
      return formatGoalDelivery(g);
    },
  },
  {
    names: ['成本', '花费', 'cost'],
    usage: '成本',
    desc: '今日/累计花费与预算',
    run: () => {
      const s = usage.stats();
      const today = s.byDay[s.today]?.cost ?? 0;
      const top = Object.entries(s.byAgent)
        .sort((a, b) => b[1].cost - a[1].cost)
        .slice(0, 5)
        .map(([id, u]) => `- ${company.agentName(id)} ${fmt(u.cost)}`);
      return r(
        '成本',
        `今日 **${fmt(today)}**${s.budget.daily ? ` / 预算 ${fmt(s.budget.daily + s.extraToday)}` : ''}\n\n累计 ${fmt(s.total.cost)} · ${s.total.calls} 次调用${s.simulated ? '（演示模式，估算值）' : ''}\n\n${top.join('\n')}`,
      );
    },
  },
  {
    names: ['目标', '下达', '下达目标', '派活', 'goal'],
    usage: '目标 [P0~P3] 标题，换行后可写详细说明',
    desc: '给公司下达新目标（默认 P2）',
    admin: true,
    run: (arg, who) => {
      const m = /^\s*(P[0-3])\b\s*/i.exec(arg);
      const priority = (m ? m[1].toUpperCase() : 'P2') as Priority;
      const rest = (m ? arg.slice(m[0].length) : arg).trim();
      const [title, ...more] = rest.split('\n');
      if (!title?.trim()) return r('下达目标', '请写上目标，例如：\n\n目标 P1 写一篇小红书文案介绍新功能');
      const g = wf.createGoal(title.trim(), more.join('\n').trim(), priority);
      bus.log('info', `老板通过${who.platform}下达目标 ${g.id}`, null, g.id);
      return r('已下达', `已下达目标 **${g.id}** [${priority}]：${g.title}\n\n经理${company.agentName(company.managerAgentId())}会先拆解派活，有需要你决策的事我会在这里提醒你。`);
    },
  },
  {
    names: ['批准', '同意', '通过', 'ok', 'approve'],
    usage: '批准 [编号] [备注]',
    desc: '批准一件待办（只有一件时可省略编号）',
    admin: true,
    run: (arg) => decide(arg, true),
  },
  {
    names: ['驳回', '拒绝', '打回', 'reject'],
    usage: '驳回 [编号] 原因',
    desc: '驳回一件待办',
    admin: true,
    run: (arg) => decide(arg, false),
  },
  {
    names: ['告诉', '转告', '问', 'tell'],
    usage: '告诉 员工名 内容',
    desc: '给某个员工插话（例如「告诉 老周 今天先做 P0」）',
    admin: true,
    run: (arg) => {
      const [name, ...rest] = arg.trim().split(/\s+/);
      const a = name ? agentByName(name) : undefined;
      if (!a) return r('告诉', `没找到员工「${name ?? ''}」。员工有：${company.profile.agents.map((x) => x.name).join('、')}`);
      const text = rest.join(' ').trim();
      if (!text) return r('告诉', `要告诉 ${a.name} 什么？例如「告诉 ${a.name} 先把测试补上」`);
      factory.message(a.id, text);
      return r('已转告', `已转告 **${a.name}**：${text}`);
    },
  },
  {
    names: ['暂停', 'pause'],
    usage: '暂停',
    desc: '全公司暂停',
    admin: true,
    run: () => {
      factory.pauseAll(true);
      return r('已暂停', '全公司已暂停。发「复工」恢复。');
    },
  },
  {
    names: ['复工', '恢复', 'resume'],
    usage: '复工',
    desc: '全公司恢复工作',
    admin: true,
    run: () => {
      factory.pauseAll(false);
      return r('已复工', '全公司恢复工作。');
    },
  },
];

function decide(arg: string, approve: boolean): Reply {
  // 第一个词像编号就当编号，其余是备注
  const [first = '', ...rest] = arg.trim().split(/\s+/);
  const looksId = /^(A-?)?[0-9a-z]{6}$/i.test(first);
  const a = findApproval(looksId ? first : '');
  if (typeof a === 'string') return r(approve ? '批准' : '驳回', a);
  // 省略编号只适用于普通操作审批；验收、请示、预算、R2 必须写明编号，避免误批
  if (!looksId && (a.kind !== 'tool' || a.risk === 'R2' || a.budget)) {
    return r('请写明编号', `这件事比较重要，请带上编号确认：\n\n${describeApproval(a)}\n\n回复「${approve ? '批准' : '驳回'} ${a.id}${approve ? '' : ' 原因'}」`);
  }
  const comment = (looksId ? rest.join(' ') : arg).trim();
  const done = store.decideApproval(a.id, approve, 'human', comment);
  if (!done) return r(approve ? '批准' : '驳回', `${a.id} 已经被处理过了。`);
  return r(approve ? '已批准' : '已驳回', `已${approve ? '批准' : '驳回'} ${describeApproval(a)}${comment ? `\n\n备注：${comment}` : ''}`);
}

function helpText(who: Sender) {
  const list = COMMANDS.filter((c) => who.admin || !c.admin)
    .map((c) => `- **${c.usage}**：${c.desc}`)
    .join('\n');
  const tip = who.admin ? '' : '\n\n> 你目前只能查询。派活、审批需要管理员权限，发「我是谁」查看如何设置。';
  return `${list}${tip}\n\n在群里请先 @ 我；单聊直接发就行。`;
}

/** 处理一条消息，返回回复 */
export async function handle(raw: string, who: Sender): Promise<Reply> {
  const text = raw.replace(/ /g, ' ').trim();
  if (!text) return r('帮助', helpText(who));
  const [head, ...restLines] = text.split('\n');
  const [word, ...restWords] = head.trim().split(/\s+/);
  const cmd = COMMANDS.find((c) => c.names.some((n) => n.toLowerCase() === word.toLowerCase()));
  if (!cmd) return r('没听懂', `没听懂「${text.slice(0, 40)}」。\n\n${helpText(who)}`);
  if (cmd.admin && !who.admin) {
    bus.log('warn', `${who.platform}用户 ${who.name}（${who.id}）尝试使用「${cmd.names[0]}」被拒绝：不是管理员`);
    return r('没有权限', `「${cmd.names[0]}」只有管理员能用。发「我是谁」查看如何设置管理员。`);
  }
  const arg = [restWords.join(' '), ...restLines].join('\n').trim();
  try {
    return await cmd.run(arg, who);
  } catch (e: any) {
    return r('出错了', `执行「${cmd.names[0]}」出错：${e?.message ?? e}`);
  }
}
