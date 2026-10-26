import fs from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import type { AgentState, Approval, Priority, Task, TaskStatus } from '@af/shared';
import { bus } from './bus.js';
import { config } from './config.js';
import type { ChatMessage } from './llm/types.js';

const shortId = customAlphabet('0123456789abcdefghijkmnpqrstuvwxyz', 6);

interface Persisted {
  tasks: Task[];
  approvals: Approval[];
  /** 每个任务的对话上下文，用于暂停/抢占后续做 */
  conversations: Record<string, ChatMessage[]>;
}

const STATE_FILE = path.join(config.dataDir, 'state.json');

class Store {
  tasks = new Map<string, Task>();
  approvals = new Map<string, Approval>();
  agents = new Map<string, AgentState>();
  conversations = new Map<string, ChatMessage[]>();
  globalPaused = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private changeListeners = new Set<() => void>();

  load() {
    if (!fs.existsSync(STATE_FILE)) return;
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Persisted;
      for (const t of s.tasks) {
        // 重启时，进行中的任务退回待办，由调度器重新派发（会带上之前的对话继续做）
        if (t.status === 'in_progress') t.status = 'todo';
        this.tasks.set(t.id, t);
      }
      for (const a of s.approvals) {
        // 重启后工具调用的等待者已经不存在，作废挂起的工具审批
        if (a.status === 'pending' && a.kind === 'tool') {
          a.status = 'rejected';
          a.comment = '服务重启，申请已作废';
        }
        this.approvals.set(a.id, a);
      }
      for (const [k, v] of Object.entries(s.conversations || {})) this.conversations.set(k, v);
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

  private changed() {
    this.onChangeNotify();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const s: Persisted = {
        tasks: [...this.tasks.values()],
        approvals: [...this.approvals.values()],
        conversations: Object.fromEntries(this.conversations),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(s));
    }, 300);
  }

  // ---------- agents ----------
  setAgent(id: string, patch: Partial<AgentState>) {
    const a = this.agents.get(id);
    if (!a) return;
    Object.assign(a, patch);
    bus.emit({ t: 'agent', d: a });
    this.changed();
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
    };
    this.tasks.set(t.id, t);
    bus.emit({ t: 'task', d: t });
    this.changed();
    return t;
  }

  updateTask(id: string, patch: Partial<Task>) {
    const t = this.tasks.get(id);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: Date.now() });
    bus.emit({ t: 'task', d: t });
    this.changed();
    return t;
  }

  children(goalId: string) {
    return [...this.tasks.values()].filter((t) => t.parentId === goalId);
  }

  saveConversation(taskKey: string, msgs: ChatMessage[]) {
    this.conversations.set(taskKey, msgs);
    this.changed();
  }

  // ---------- approvals ----------
  private waiters = new Map<string, (a: Approval) => void>();
  /** 审批决定后的业务回调（由 workflow 注册，避免循环依赖） */
  onDecided?: (a: Approval) => void;

  createApproval(input: Omit<Approval, 'id' | 'status' | 'createdAt'>): Approval {
    const a: Approval = { ...input, id: 'A-' + shortId(), status: 'pending', createdAt: Date.now() };
    this.approvals.set(a.id, a);
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
    bus.emit({ t: 'approval', d: a });
    this.changed();
    return a;
  }
}

export const store = new Store();
