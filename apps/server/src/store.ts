import fs from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import type { AgentState, Approval, Meeting, Priority, Task, TaskStatus } from '@af/shared';
import { bus } from './bus.js';
import { config } from './config.js';
import { db, type PersistedJob } from './db.js';
import type { ChatMessage } from './llm/types.js';

const shortId = customAlphabet('0123456789abcdefghijkmnpqrstuvwxyz', 6);

interface Persisted {
  tasks: Task[];
  approvals: Approval[];
  /** 每个任务的对话上下文，用于暂停/抢占后续做 */
  conversations: Record<string, ChatMessage[]>;
  meetings?: Meeting[];
  jobs?: PersistedJob[];
}

const STATE_FILE = path.join(config.dataDir, 'state.json');

class Store {
  tasks = new Map<string, Task>();
  approvals = new Map<string, Approval>();
  agents = new Map<string, AgentState>();
  conversations = new Map<string, ChatMessage[]>();
  meetings = new Map<string, Meeting>();
  restoredJobs: PersistedJob[] = [];
  globalPaused = false;
  private speechTimers = new Map<string, NodeJS.Timeout>();
  private saveTimer: NodeJS.Timeout | null = null;
  private changeListeners = new Set<() => void>();

  private hydrate(s: Persisted, syncToDb = false) {
    for (const t of s.tasks ?? []) {
      // 重启时，进行中的任务退回待办，由调度器重新派发（会带上之前的对话继续做）
      if (t.status === 'in_progress') t.status = 'todo';
      t.acceptance ??= '';
      t.notes ??= [];
      t.artifacts ??= [];
      this.tasks.set(t.id, t);
      if (syncToDb) db.upsertTask(t);
    }
    for (const a of s.approvals ?? []) {
      // 重启后工具调用的等待者已经不存在，作废挂起的工具审批
      if (a.status === 'pending' && a.kind === 'tool') {
        a.status = 'rejected';
        a.comment = '服务重启，申请已作废';
      }
      this.approvals.set(a.id, a);
      if (syncToDb) db.upsertApproval(a);
    }
    for (const [k, v] of Object.entries(s.conversations || {})) {
      this.conversations.set(k, v);
      if (syncToDb) db.saveConversation(k, v);
    }
    for (const m of s.meetings ?? []) {
      // 重启时没开完的会作废
      if (m.status !== 'done') m.status = 'done';
      this.meetings.set(m.id, m);
      if (syncToDb) db.upsertMeeting(m);
    }
    this.restoredJobs = s.jobs ?? [];
  }

  async load() {
    if (db.ready) {
      const fromDb = await db.loadState();
      if (fromDb && (fromDb.tasks.length > 0 || fromDb.approvals.length > 0)) {
        this.hydrate(fromDb, false);
        bus.log('info', `已从 PostgreSQL 加载 ${this.tasks.size} 个任务、${this.approvals.size} 条审批记录`);
        return;
      }
    }
    if (!fs.existsSync(STATE_FILE)) return;
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Persisted;
      this.hydrate(s, db.ready);
      if (db.ready) {
        bus.log('info', `已将本地 state.json (${this.tasks.size} 个任务) 自动迁移至 PostgreSQL`);
      }
    } catch (e) {
      console.error('加载 state.json 失败', e);
    }
  }

  onChange(fn: () => void) {
    this.changeListeners.add(fn);
  }

  /** 只通知调度器，不落盘 */
  onChangeNotify() {
    for (const fn of this.changeListeners) queueMicrotask(fn);
  }

  /** 原子写本地备份文件（PostgreSQL 启用时降低写盘频率作为灾备快照；未启用时 500ms 原子写盘防损坏） */
  private changed() {
    this.onChangeNotify();
    if (this.saveTimer) return;
    const delay = db.ready ? 5000 : 500;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const s: Persisted = {
          tasks: [...this.tasks.values()],
          approvals: [...this.approvals.values()],
          conversations: Object.fromEntries(this.conversations),
          meetings: [...this.meetings.values()].slice(-30),
        };
        const tmp = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(s));
        fs.renameSync(tmp, STATE_FILE);
      } catch (e) {
        console.error('写入 state.json 失败', e);
      }
    }, delay);
  }

  // ---------- agents ----------
  setAgent(id: string, patch: Partial<AgentState>) {
    const a = this.agents.get(id);
    if (!a) return;
    Object.assign(a, patch);
    bus.emit({ t: 'agent', d: a });
    this.changed();
  }

  /** 说一句话：头顶出现对话气泡，一段时间后自动消失 */
  say(agentId: string, text: string, holdMs = 9000) {
    clearTimeout(this.speechTimers.get(agentId));
    this.setAgent(agentId, { speech: text });
    this.speechTimers.set(
      agentId,
      setTimeout(() => this.setAgent(agentId, { speech: null }), holdMs),
    );
  }

  // ---------- meetings ----------
  createMeeting(input: Omit<Meeting, 'id' | 'status' | 'transcript' | 'summary' | 'createdAt'>): Meeting {
    const m: Meeting = { ...input, id: 'M-' + shortId(), status: 'gathering', transcript: [], summary: '', createdAt: Date.now() };
    this.meetings.set(m.id, m);
    db.upsertMeeting(m);
    bus.emit({ t: 'meeting', d: m });
    this.changed();
    return m;
  }

  updateMeeting(id: string, patch: Partial<Meeting>) {
    const m = this.meetings.get(id);
    if (!m) return;
    Object.assign(m, patch);
    db.upsertMeeting(m);
    bus.emit({ t: 'meeting', d: m });
    this.changed();
    return m;
  }

  // ---------- tasks ----------
  createTask(input: {
    kind: Task['kind'];
    title: string;
    description: string;
    priority: Priority;
    parentId?: string | null;
    assigneeRoleId?: string | null;
    assigneeAgentId?: string | null;
    dependsOn?: string[];
    createdBy: string;
    status?: TaskStatus;
    acceptance?: string;
  }): Task {
    const now = Date.now();
    const t: Task = {
      id: (input.kind === 'goal' ? 'G-' : 'T-') + shortId(),
      kind: input.kind,
      title: input.title,
      description: input.description,
      priority: input.priority,
      status: input.status ?? 'todo',
      parentId: input.parentId ?? null,
      assigneeRoleId: input.assigneeRoleId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      dependsOn: input.dependsOn ?? [],
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      reviewRounds: 0,
      result: '',
      feedback: '',
      acceptance: input.acceptance ?? '',
      notes: [],
      artifacts: [],
    };
    this.tasks.set(t.id, t);
    db.upsertTask(t);
    bus.emit({ t: 'task', d: t });
    this.changed();
    return t;
  }

  updateTask(id: string, patch: Partial<Task>) {
    const t = this.tasks.get(id);
    if (!t) return;
    const now = Date.now();
    if (patch.status === 'in_progress' && !t.startedAt) t.startedAt = now;
    if (patch.status === 'done' || patch.status === 'cancelled') t.finishedAt = now;
    else if (patch.status && t.finishedAt) t.finishedAt = undefined;
    Object.assign(t, patch, { updatedAt: now });
    db.upsertTask(t);
    bus.emit({ t: 'task', d: t });
    this.changed();
    return t;
  }

  /** 记录任务产出的文件（交付页用），忽略 .tmp 等临时文件 */
  addArtifact(taskId: string | null, relPath: string) {
    if (/^(\.tmp|node_modules|\.git)(\/|-|$)/.test(relPath)) return;
    const t = taskId ? this.tasks.get(taskId) : undefined;
    if (!t || t.artifacts.includes(relPath)) return;
    this.updateTask(t.id, { artifacts: [...t.artifacts, relPath] });
  }

  children(goalId: string) {
    return [...this.tasks.values()].filter((t) => t.parentId === goalId);
  }

  saveConversation(taskKey: string, msgs: ChatMessage[]) {
    this.conversations.set(taskKey, msgs);
    db.saveConversation(taskKey, msgs);
    this.changed();
  }

  deleteConversation(taskKey: string) {
    this.conversations.delete(taskKey);
    db.deleteConversation(taskKey);
    this.changed();
  }

  // ---------- approvals ----------
  private waiters = new Map<string, (a: Approval) => void>();
  /** 审批决定后的业务回调（由 workflow 注册，避免循环依赖） */
  onDecided?: (a: Approval) => void;

  createApproval(input: Omit<Approval, 'id' | 'status' | 'createdAt'>): Approval {
    const a: Approval = { ...input, id: 'A-' + shortId(), status: 'pending', createdAt: Date.now() };
    this.approvals.set(a.id, a);
    db.upsertApproval(a);
    bus.emit({ t: 'approval', d: a });
    this.changed();
    return a;
  }

  /** 等待审批结果（工具调用会阻塞在这里） */
  waitApproval(id: string): Promise<Approval> {
    const a = this.approvals.get(id)!;
    if (a.status !== 'pending') return Promise.resolve(a);
    return new Promise((res) => this.waiters.set(id, res));
  }

  decideApproval(id: string, approved: boolean, decidedBy: string, comment = ''): Approval | null {
    const a = this.approvals.get(id);
    if (!a || a.status !== 'pending') return null;
    a.status = approved ? 'approved' : 'rejected';
    a.decidedBy = decidedBy;
    a.comment = comment;
    a.decidedAt = Date.now();
    db.upsertApproval(a);
    bus.emit({ t: 'approval', d: a });
    this.changed();
    this.waiters.get(id)?.(a);
    this.waiters.delete(id);
    this.onDecided?.(a);
    return a;
  }

  /** 把审批改派给老板（经理升级） */
  escalateApproval(id: string, note: string) {
    const a = this.approvals.get(id);
    if (!a || a.status !== 'pending') return null;
    a.approver = 'human';
    a.detail = `${a.detail}\n\n【经理意见】${note}`;
    db.upsertApproval(a);
    bus.emit({ t: 'approval', d: a });
    this.changed();
    return a;
  }
}

export const store = new Store();
