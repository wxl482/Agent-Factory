import { PRIORITY_ORDER, type Task } from '@af/shared';
import { AgentRunner } from './agent/runtime.js';
import { bus } from './bus.js';
import { company } from './company.js';
import type { LLM } from './llm/types.js';
import { store } from './store.js';
import { closeAllBrowsers } from './tools/browser.js';
import { registerCustomTools } from './tools/index.js';
import { clearScreens } from './tools/screens.js';
import { killAllTerminals } from './tools/terminal.js';
import * as wf from './workflow.js';
import { DESK, life } from './life.js';
import { usage } from './usage.js';

/** 公司：持有所有员工，负责调度 */
class Factory {
  runners = new Map<string, AgentRunner>();
  private llm!: LLM;
  private scheduling = false;

  init(llm: LLM, profileId: string) {
    this.llm = llm;
    company.load(profileId);
    registerCustomTools(company.profile.customTools);
    for (const def of company.profile.agents) {
      const prev = store.agents.get(def.id);
      store.agents.set(def.id, {
        id: def.id,
        name: def.name,
        roleId: def.roleId,
        status: 'idle',
        screen: 'idle',
        paused: false,
        currentTaskId: null,
        activity: '空闲',
        tokens: prev?.tokens ?? { input: 0, output: 0 },
        location: DESK,
        speech: null,
      });
      this.runners.set(def.id, new AgentRunner(def, llm));
    }
    this.rebuildJobs();
    store.onChange(() => this.schedule());
    life.start();
    bus.log('info', `公司「${company.profile.name}」开张，${company.profile.agents.length} 名员工就位`);
    this.schedule();
  }

  /** 重启后恢复持久化的待办队列，并根据任务状态自愈对账 */
  private rebuildJobs() {
    if (store.restoredJobs.length) {
      wf.restoreJobs(store.restoredJobs);
      store.restoredJobs = [];
    }
    for (const t of store.tasks.values()) {
      if (t.status === 'review') wf.submitForReview(t, t.assigneeAgentId ?? '?', t.result);
      if (t.status === 'blocked') wf.reportBlocked(t, t.assigneeAgentId ?? '?', t.result);
      if (t.kind === 'goal' && t.status === 'planning' && store.children(t.id).length === 0) {
        wf.enqueueJob({ priority: t.priority, taskId: t.id, title: `规划目标 ${t.id}`, prompt: `请规划目标 ${t.id}：${t.title}\n${t.description}\n用 create_subtask 拆解派发。` });
      }
      if (t.kind === 'goal' && t.status === 'in_progress') {
        wf.checkGoal(t.id);
      }
    }
  }

  async switchProfile(id: string) {
    if ([...this.runners.values()].some((r) => r.busy)) throw new Error('还有员工在工作，请先暂停或等待完成');
    killAllTerminals();
    await closeAllBrowsers();
    clearScreens();
    this.runners.clear();
    store.agents.clear();
    this.init(this.llm, id);
  }

  private ready(t: Task) {
    return t.dependsOn.every((d) => {
      const s = store.tasks.get(d)?.status;
      return s === 'done' || s === 'cancelled' || s === undefined;
    });
  }

  private candidates(r: AgentRunner) {
    return [...store.tasks.values()]
      .filter(
        (t) =>
          t.kind === 'task' &&
          (t.status === 'todo' || t.status === 'changes_requested') &&
          t.assigneeRoleId === r.role.id &&
          (!t.assigneeAgentId || t.assigneeAgentId === r.id) &&
          !usage.isGoalHeld(t.id) &&
          this.ready(t),
      )
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || Number(b.assigneeAgentId === r.id) - Number(a.assigneeAgentId === r.id) || a.createdAt - b.createdAt);
  }

  /** 有没有等着这个员工做的事（事项或可领取的任务） */
  hasWork(r: AgentRunner) {
    return !!wf.peekJob(r.id) || (!r.isManager && this.candidates(r).length > 0);
  }

  schedule() {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      if (store.globalPaused) return;
      for (const r of this.runners.values()) {
        if (r.busy || r.state.paused || life.isAway(r.id)) continue;
        const job = wf.takeJob(r.id);
        if (job) {
          void r.runJob(job);
          continue;
        }
        if (r.isManager) continue;
        const task = this.candidates(r)[0];
        if (task) void r.runTask(task);
      }
      this.preempt();
    } finally {
      this.scheduling = false;
    }
  }

  /** P0 抢占：有 P0 任务没人做，而同角色的员工在做低优先级任务 */
  private preempt() {
    const waitingP0 = [...store.tasks.values()].filter((t) => t.kind === 'task' && t.priority === 'P0' && (t.status === 'todo' || t.status === 'changes_requested') && this.ready(t));
    for (const t of waitingP0) {
      // 每个 P0 任务只让一个人让出
      if ([...this.runners.values()].some((r) => r.preemptFor === t.id)) continue;
      const victim = [...this.runners.values()].find((r) => {
        if (!r.busy || r.interrupt || r.role.id !== t.assigneeRoleId) return false;
        if (t.assigneeAgentId && t.assigneeAgentId !== r.id) return false;
        const cur = r.state.currentTaskId ? store.tasks.get(r.state.currentTaskId) : undefined;
        return cur?.kind === 'task' && cur.priority !== 'P0';
      });
      if (victim) {
        victim.interrupt = true;
        victim.preemptFor = t.id;
        bus.log('warn', `P0 任务 ${t.id} 到达，通知 ${victim.def.name} 让出当前工作`, victim.id, t.id);
      }
    }
  }

  // ---------------- 老板的干预 ----------------
  pause(agentId: string, paused: boolean) {
    store.setAgent(agentId, { paused, ...(paused ? {} : { status: this.runners.get(agentId)?.busy ? 'working' : 'idle' }) });
    bus.log('info', `${paused ? '暂停' : '恢复'} ${company.agentName(agentId)}`, agentId);
    if (!paused) this.schedule();
  }

  pauseAll(paused: boolean) {
    store.globalPaused = paused;
    bus.emit({ t: 'paused', d: paused });
    bus.log('warn', paused ? '老板按下了全公司暂停' : '全公司恢复工作');
    if (!paused) {
      for (const r of this.runners.values()) if (!r.busy && !r.state.paused) store.setAgent(r.id, { status: 'idle', activity: '空闲' });
      this.schedule();
    }
  }

  message(agentId: string, text: string) {
    this.runners.get(agentId)?.inject(text);
    this.schedule();
  }
}

export const factory = new Factory();
