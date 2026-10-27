import fs from 'node:fs';
import path from 'node:path';
import type { AgentLocation, MeetingLine } from '@af/shared';
import { buildSystemPrompt } from './agent/prompts.js';
import { bus } from './bus.js';
import { company } from './company.js';
import { config } from './config.js';
import { factory } from './factory.js';
import { completeAs } from './llm/index.js';
import type { CompleteKind } from './llm/types.js';
import { store } from './store.js';
import { addGoalNote, describeTask } from './workflow.js';

/**
 * 办公室里的“生活”：员工的位置与走动、开会、当面请示/请教、经理谈话、空闲时去茶水间。
 * 位置由服务端决定并广播，前端负责把奶蛙沿走廊走过去。
 */

export const DESK: AgentLocation = { kind: 'desk' };
/** 前端走路动画最长约 4 秒，服务端按这个时间等待“到达” */
export const WALK_MS = 4200;
const PANTRY_SPOTS = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function def(id: string) {
  return company.profile.agents.find((a) => a.id === id)!;
}

function persona(id: string, situation: string) {
  const d = def(id);
  return `${buildSystemPrompt(d, company.role(d.roleId))}\n\n## 当前情境\n${situation}\n你现在只能口头交流（不能使用任何工具），回答要简洁、具体、可执行；超出你职责的问题直接说明并建议找谁。`;
}

async function say(id: string, kind: CompleteKind, system: string, user: string, maxTokens = 400) {
  const text = (await completeAs(id, def(id).roleId, { kind, system, user, maxTokens })).trim() || '……';
  store.say(id, text.length > 160 ? text.slice(0, 160) + '…' : text, 12000);
  return text;
}

/** 某个员工手头在做什么（给被请教的人做背景） */
function workContext(id: string) {
  const a = store.agents.get(id);
  const t = a?.currentTaskId ? store.tasks.get(a.currentTaskId) : undefined;
  return t ? `${t.id}「${t.title}」：${t.description}` : '目前没有进行中的任务';
}

function openWork() {
  const open = [...store.tasks.values()].filter((t) => !['done', 'cancelled'].includes(t.status));
  return open.map(describeTask).join('\n') || '(没有进行中的目标和任务)';
}

class Life {
  /** 被叫走（开会/谈话）期间不派新活 */
  private away = new Set<string>();
  private pantryUntil = new Map<string, number>();
  private ticker: NodeJS.Timeout | null = null;

  isAway(id: string) {
    return this.away.has(id);
  }

  async walk(id: string, loc: AgentLocation) {
    this.pantryUntil.delete(id);
    store.setAgent(id, { location: loc });
    await sleep(WALK_MS);
  }

  /** 开工前先回到工位（比如正在茶水间） */
  async ensureAtDesk(id: string) {
    if (store.agents.get(id)?.location.kind !== 'desk') await this.walk(id, DESK);
  }

  /**
   * 把员工叫到某处。忙的员工会在当前这一步做完后起身（不会打断正在执行的命令）；
   * 超时没来就返回 null。返回的 release() 让他走回工位并继续原来的工作。
   */
  async summon(id: string, loc: AgentLocation, timeoutMs = 90_000): Promise<null | (() => Promise<void>)> {
    const r = factory.runners.get(id);
    if (!r || this.away.has(id)) return null;
    this.away.add(id);
    const hold = r.busy ? r.requestHold() : null;
    if (hold) {
      const came = await Promise.race([hold.arrived.then(() => true), sleep(timeoutMs).then(() => false)]);
      if (!came) {
        hold.release();
        this.away.delete(id);
        bus.log('warn', `${def(id).name} 手头的操作还没完成，没能过来`, id);
        return null;
      }
    }
    await this.walk(id, loc);
    return async () => {
      await this.walk(id, DESK);
      this.away.delete(id);
      hold?.release();
      factory.schedule();
    };
  }

  // ---------------- 当面请示 / 请教 ----------------

  /** 员工带着问题走到对方那里（经理室或同事工位），当面拿到答复后回工位 */
  async consult(fromId: string, toId: string, question: string) {
    const to = def(toId);
    const isManager = company.isManager(toId);
    const reason = isManager ? `去找${to.name}请示` : `去找${to.name}请教`;
    store.setAgent(fromId, { activity: reason });
    // 同时来找同一个人的，各站各的位置
    const seat = [...store.agents.values()].filter((a) => a.id !== fromId && a.location.target === toId && (a.location.kind === 'office' || a.location.kind === 'visit')).length;
    await this.walk(fromId, { kind: isManager ? 'office' : 'visit', target: toId, reason, seat });
    store.say(fromId, question, 10000);
    bus.log('info', `💬 → ${to.name}：${question}`, fromId);

    const from = def(fromId);
    const situation = isManager
      ? `${from.name}（${company.roleName(from.roleId)}）来你的经理室当面请示。公司当前的工作：\n${openWork()}`
      : `同事 ${from.name}（${company.roleName(from.roleId)}）走到你工位来请教。你手头在做：${workContext(toId)}`;
    const answer = await say(toId, 'consult', persona(toId, situation), `${from.name}问：${question}\n\n他正在做的任务：${workContext(fromId)}`, 500);
    bus.log('info', `💬 → ${from.name}：${answer}`, toId);

    await sleep(3000);
    await this.walk(fromId, DESK);
    return answer;
  }

  /** 经理把员工叫到经理室谈话；谈话内容会写进员工手上任务的上下文 */
  async talk(managerId: string, workerId: string, message: string) {
    const w = def(workerId);
    const release = await this.summon(workerId, { kind: 'office', target: managerId, reason: `被叫到经理室谈话` });
    if (!release) {
      factory.runners.get(workerId)?.inject(`【经理留言】${message}`, 'manager');
      return `${w.name} 暂时走不开，已改为留言：${message}`;
    }
    store.say(managerId, message, 12000);
    bus.log('info', `💬 → ${w.name}：${message}`, managerId);
    await sleep(2500);
    const reply = await say(
      workerId,
      'consult',
      persona(workerId, `经理把你叫到经理室谈话。你手头在做：${workContext(workerId)}`),
      `经理对你说：${message}\n请当面回应（表态、说明情况或提出需要的支持）。`,
      300,
    );
    bus.log('info', `💬 → ${def(managerId).name}：${reply}`, workerId);
    factory.runners.get(workerId)?.inject(`【经理谈话】经理当面对你说：${message}\n你的回应：${reply}`, 'manager');
    await sleep(3000);
    await release();
    return `${w.name} 的回应：${reply}`;
  }

  // ---------------- 会议 ----------------

  async meeting(hostId: string, a: { topic: string; agenda: string; participants: string[]; taskId: string | null; rounds?: number }) {
    const valid = [...new Set(a.participants)].filter((id) => id !== hostId && company.profile.agents.some((x) => x.id === id));
    if (!valid.length) throw new Error(`参会人无效，可选：${company.profile.agents.filter((x) => x.id !== hostId).map((x) => `${x.id}(${x.name})`).join(', ')}`);
    const rounds = Math.min(Math.max(a.rounds ?? 1, 1), 3);
    const m = store.createMeeting({ topic: a.topic, agenda: a.agenda, hostId, participants: valid, taskId: a.taskId });
    bus.log('info', `📅 召集会议「${a.topic}」：${valid.map((id) => def(id).name).join('、')}`, hostId, a.taskId);

    // 主持人和参会人一起走向会议室
    store.setAgent(hostId, { activity: `主持会议：${a.topic}` });
    const hostWalk = this.walk(hostId, { kind: 'meeting', target: m.id, seat: 0, reason: `主持会议` });
    const releases = await Promise.all(valid.map((id, i) => this.summon(id, { kind: 'meeting', target: m.id, seat: i + 1, reason: `开会：${a.topic}` }, 60_000)));
    await hostWalk;
    const attendees = valid.filter((_, i) => releases[i]);
    store.updateMeeting(m.id, { status: 'ongoing', participants: attendees });

    const transcript: MeetingLine[] = [];
    const transcriptText = () => transcript.map((l) => `${def(l.agentId).name}（${company.roleName(def(l.agentId).roleId)}）：${l.text}`).join('\n');
    const record = async (id: string, text: string) => {
      transcript.push({ agentId: id, text, ts: Date.now() });
      store.updateMeeting(m.id, { transcript: [...transcript] });
      bus.log('info', `🗣 ${text}`, id, a.taskId);
      await sleep(Math.min(6000, 1500 + text.length * 35)); // 留时间让大家“听完”
    };
    const ctx = a.taskId ? `相关工作：\n${openWork()}` : '';
    const situationFor = (id: string) => `你正在会议室参加会议「${a.topic}」，主持人是 ${def(hostId).name}，参会人：${[hostId, ...attendees].map((x) => def(x).name).join('、')}。`;

    try {
      await record(
        hostId,
        await say(hostId, 'meeting_open', persona(hostId, `你在会议室主持会议。${ctx}`), `议题：${a.topic}\n议程：${a.agenda}\n\n请开场（100 字以内）：说明背景、目标和希望大家讨论的问题。`, 300),
      );
      for (let r = 0; r < rounds; r++) {
        for (const id of attendees) {
          await record(
            id,
            await say(
              id,
              'meeting_speak',
              persona(id, situationFor(id)),
              `议题：${a.topic}\n议程：${a.agenda}\n\n会议记录：\n${transcriptText()}\n\n轮到你发言（100 字以内）：从你的岗位职责出发，说明你负责哪部分、方案或顾虑、需要谁配合。不要重复别人说过的话；与你岗位无关就简短表态。`,
              300,
            ),
          );
        }
      }
      const summary = await say(
        hostId,
        'meeting_summary',
        persona(hostId, `会议「${a.topic}」讨论结束，你要整理会议纪要。`),
        `议程：${a.agenda}\n\n会议记录：\n${transcriptText()}\n\n请输出会议纪要（Markdown，300 字以内）：结论、分工（谁负责什么、交付物、验收标准）、风险与待确认事项。`,
        700,
      );
      store.updateMeeting(m.id, { status: 'done', summary, transcript: [...transcript] });

      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const file = path.join('docs/meetings', `${stamp}-${a.topic.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}.md`);
      fs.mkdirSync(path.join(config.workspace, 'docs/meetings'), { recursive: true });
      fs.writeFileSync(
        path.join(config.workspace, file),
        `# ${a.topic}\n\n- 时间：${new Date().toLocaleString('zh-CN')}\n- 主持：${def(hostId).name}\n- 参会：${attendees.map((x) => def(x).name).join('、')}\n\n## 议程\n${a.agenda}\n\n## 发言记录\n${transcript.map((l) => `- **${def(l.agentId).name}**：${l.text}`).join('\n')}\n\n## 纪要\n${summary}\n`,
      );
      addGoalNote(a.taskId, `【会议「${a.topic}」纪要，全文见 ${file}】\n${summary}`);
      bus.log('success', `会议「${a.topic}」结束，纪要已保存到 ${file}`, hostId, a.taskId);
      return `会议纪要（已保存到 ${file}，并附在目标上供执行人参考）：\n${summary}`;
    } finally {
      if (store.meetings.get(m.id)?.status !== 'done') store.updateMeeting(m.id, { status: 'done', summary: '会议中断' });
      await Promise.all([this.walk(hostId, DESK), ...releases.map((rel) => rel?.())]);
    }
  }

  // ---------------- 空闲时的日常：去茶水间 ----------------

  start() {
    this.ticker ??= setInterval(() => this.tick(), 8000);
  }

  private tick() {
    const now = Date.now();
    for (const [id, until] of this.pantryUntil) {
      if (now > until) {
        this.pantryUntil.delete(id);
        store.setAgent(id, { location: DESK });
      }
    }
    if (store.globalPaused) return;
    const inPantry = this.pantryUntil.size;
    for (const r of factory.runners.values()) {
      const s = r.state;
      if (r.busy || s.paused || this.away.has(r.id) || s.location.kind !== 'desk') continue;
      if (now - r.idleSince < 20_000 || factory.hasWork(r)) continue;
      if (inPantry >= 3 || Math.random() > 0.1) continue;
      const seat = Math.floor(Math.random() * PANTRY_SPOTS);
      this.pantryUntil.set(r.id, now + 30_000 + Math.random() * 40_000);
      store.setAgent(r.id, { location: { kind: 'pantry', seat, reason: '去茶水间' } });
      bus.log('debug', '去茶水间倒杯咖啡', r.id);
      break;
    }
  }
}

export const life = new Life();
