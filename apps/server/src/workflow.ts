import { PRIORITY_ORDER, type Approval, type Priority, type Task } from '@af/shared';
import { bus } from './bus.js';
import { store } from './store.js';
import { company } from './company.js';

/** 经理（或任意 Agent）的待处理事项。员工的工作单元就是 Task 本身。 */
export interface Job {
  id: string;
  agentId: string;
  priority: Priority;
  title: string;
  prompt: string;
  taskId: string | null;
  createdAt: number;
}

let jobSeq = 0;
export const jobs: Job[] = [];

export function enqueueJob(j: Omit<Job, 'id' | 'createdAt' | 'agentId'> & { agentId?: string }) {
  const job: Job = { ...j, agentId: j.agentId ?? company.managerAgentId(), id: `J${++jobSeq}`, createdAt: Date.now() };
  // 同一任务同类事项不重复排队
  if (jobs.some((x) => x.agentId === job.agentId && x.title === job.title && x.taskId === job.taskId)) return;
  jobs.push(job);
  jobs.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt);
  bus.log('debug', `新事项排队：${job.title}`, job.agentId, job.taskId);
  store.onChangeNotify();
}

export function takeJob(agentId: string): Job | null {
  const i = jobs.findIndex((j) => j.agentId === agentId);
  return i >= 0 ? jobs.splice(i, 1)[0] : null;
}

export function peekJob(agentId: string) {
  return jobs.find((j) => j.agentId === agentId) ?? null;
}

// ---------------- 描述信息 ----------------

const STATUS_CN: Record<Task['status'], string> = {
  planning: '规划中',
  todo: '待办',
  in_progress: '进行中',
  review: '待评审',
  changes_requested: '返工中',
  blocked: '受阻',
  awaiting_human: '等老板',
  done: '完成',
  cancelled: '取消',
};

export function describeTask(t: Task) {
  const who = t.assigneeAgentId ? company.agentName(t.assigneeAgentId) : t.assigneeRoleId ? company.roleName(t.assigneeRoleId) : '-';
  return `- ${t.id} [${t.priority}] [${STATUS_CN[t.status]}] ${t.title}（负责：${who}${t.dependsOn.length ? `，依赖：${t.dependsOn.join(',')}` : ''}）`;
}

function goalContext(goal: Task) {
  const kids = store.children(goal.id);
  return `目标 ${goal.id} [${goal.priority}]：${goal.title}\n目标描述：${goal.description || '(无)'}\n${
    goal.feedback ? `老板最近的反馈：${goal.feedback}\n` : ''
  }\n当前子任务：\n${kids.map(describeTask).join('\n') || '(暂无)'}`;
}

// ---------------- 流转 ----------------

export function createGoal(title: string, description: string, priority: Priority) {
  const g = store.createTask({ kind: 'goal', title, description, priority, createdBy: 'human', status: 'planning' });
  bus.log('info', `老板下达新目标 ${g.id}：${title}`, null, g.id);
  enqueuePlan(g);
  return g;
}

function enqueuePlan(goal: Task) {
  enqueueJob({
    priority: goal.priority,
    taskId: goal.id,
    title: `规划目标 ${goal.id}`,
    prompt: `${goalContext(goal)}\n\n请规划这个目标：先用 list_files / read_file 了解工作区现状，然后用 create_subtask 拆解并派发子任务（注意用 depends_on 安排先后顺序）。派发完成即可结束本次处理。`,
  });
}

export function createSubtask(goalId: string, a: { title: string; description: string; role: string; priority?: Priority; depends_on?: string[] }) {
  const goal = store.tasks.get(goalId);
  if (!goal) throw new Error(`目标 ${goalId} 不存在`);
  if (!company.profile.roles.some((r) => r.id === a.role)) throw new Error(`角色 ${a.role} 不存在，可选：${company.workerRoles().map((r) => r.id).join(', ')}`);
  const deps = (a.depends_on ?? []).filter((d) => store.tasks.has(d));
  const t = store.createTask({
    kind: 'task',
    title: a.title,
    description: a.description,
    priority: a.priority ?? goal.priority,
    parentId: goalId,
    assigneeRoleId: a.role,
    dependsOn: deps,
    createdBy: company.managerAgentId(),
  });
  if (goal.status === 'planning') store.updateTask(goalId, { status: 'in_progress' });
  bus.log('info', `派发 ${t.id} [${t.priority}] 给${company.roleName(a.role)}：${t.title}`, company.managerAgentId(), t.id);
  return t;
}

export function submitForReview(task: Task, agentId: string, summary: string) {
  store.updateTask(task.id, { status: 'review', result: summary });
  bus.log('success', `提交评审 ${task.id}：${summary.slice(0, 120)}`, agentId, task.id);
  enqueueJob({
    priority: task.priority,
    taskId: task.id,
    title: `评审 ${task.id}`,
    prompt: `${company.agentName(agentId)} 提交了任务，请评审。\n\n任务 ${task.id}：${task.title}\n任务描述：${task.description}\n已返工次数：${task.reviewRounds}\n\n员工的工作总结：\n${summary}\n\n${
      task.parentId ? goalContext(store.tasks.get(task.parentId)!) : ''
    }\n\n请亲自检查产出（read_file、run_command 如 git log/diff、运行测试等），然后调用 approve_task 或 request_changes。`,
  });
}

export function reportBlocked(task: Task, agentId: string, reason: string) {
  store.updateTask(task.id, { status: 'blocked', result: reason });
  bus.log('warn', `任务受阻 ${task.id}：${reason}`, agentId, task.id);
  enqueueJob({
    priority: task.priority,
    taskId: task.id,
    title: `处理受阻 ${task.id}`,
    prompt: `${company.agentName(agentId)} 报告任务受阻。\n任务 ${task.id}：${task.title}\n原因：${reason}\n\n请决定：request_changes 给出指导让其继续、create_subtask 补充前置任务、cancel_task 取消，或 escalate_to_human 交给老板。`,
  });
}

export function approveTask(task: Task, comment: string, by: string) {
  store.updateTask(task.id, { status: 'done', feedback: comment });
  bus.log('success', `评审通过 ${task.id}${comment ? `：${comment}` : ''}`, by, task.id);
  checkGoal(task.parentId);
}

export function requestChanges(task: Task, feedback: string, by: string) {
  const rounds = task.reviewRounds + 1;
  if (rounds > company.profile.policy.maxReviewRounds) {
    store.updateTask(task.id, { status: 'awaiting_human', feedback, reviewRounds: rounds });
    const a = store.createApproval({
      kind: 'question',
      taskId: task.id,
      requesterId: by,
      approver: 'human',
      risk: 'R1',
      title: `${task.id} 已返工 ${rounds - 1} 次仍未通过，需要老板裁决`,
      detail: `任务：${task.title}\n\n员工最近的总结：\n${task.result}\n\n经理的意见：\n${feedback}`,
      options: ['通过验收', '继续返工（请在备注里写指导意见）'],
    });
    bus.log('warn', `返工次数超限，升级给老板 ${a.id}`, by, task.id);
    return 'escalated';
  }
  store.updateTask(task.id, { status: 'changes_requested', feedback, reviewRounds: rounds });
  bus.log('warn', `打回 ${task.id}（第 ${rounds} 次）：${feedback.slice(0, 120)}`, by, task.id);
  return 'changes_requested';
}

export function cancelTask(task: Task, reason: string, by: string) {
  store.updateTask(task.id, { status: 'cancelled', feedback: reason });
  bus.log('warn', `取消任务 ${task.id}：${reason}`, by, task.id);
  checkGoal(task.parentId);
}

function checkGoal(goalId: string | null) {
  if (!goalId) return;
  const goal = store.tasks.get(goalId);
  if (!goal || goal.status === 'done' || goal.status === 'awaiting_human') return;
  const kids = store.children(goalId);
  if (kids.length && kids.every((k) => k.status === 'done' || k.status === 'cancelled')) {
    enqueueJob({
      priority: goal.priority,
      taskId: goal.id,
      title: `交付目标 ${goal.id}`,
      prompt: `${goalContext(goal)}\n\n所有子任务均已完成。请检查整体产出是否达成目标：达成则调用 finalize_goal 写交付总结（产出在哪、怎么使用/运行、遗留问题）；没达成就继续 create_subtask。`,
    });
  }
}

export function finalizeGoal(goal: Task, summary: string, by: string) {
  store.updateTask(goal.id, { result: summary });
  if (company.profile.policy.requireHumanAcceptance) {
    store.updateTask(goal.id, { status: 'awaiting_human' });
    store.createApproval({
      kind: 'acceptance',
      taskId: goal.id,
      requesterId: by,
      approver: 'human',
      risk: 'R2',
      title: `目标交付验收：${goal.title}`,
      detail: summary,
    });
    bus.log('info', `目标 ${goal.id} 提交老板验收`, by, goal.id);
  } else {
    store.updateTask(goal.id, { status: 'done' });
    bus.log('success', `目标 ${goal.id} 完成`, by, goal.id);
  }
}

export function escalateToHuman(by: string, taskId: string | null, question: string, options: string[]) {
  const a = store.createApproval({
    kind: 'question',
    taskId,
    requesterId: by,
    approver: 'human',
    risk: 'R2',
    title: question.split('\n')[0].slice(0, 80),
    detail: question,
    options,
  });
  bus.log('warn', `请示老板 ${a.id}：${question.slice(0, 100)}`, by, taskId);
  return a;
}

/** 审批被决定后的业务处理（老板或经理） */
export function onApprovalDecided(a: Approval) {
  const task = a.taskId ? store.tasks.get(a.taskId) : undefined;
  const decision = a.status === 'approved' ? '同意' : '驳回';
  bus.log(a.status === 'approved' ? 'success' : 'warn', `${a.decidedBy === 'human' ? '老板' : company.agentName(a.decidedBy!)}${decision}：${a.title}${a.comment ? `（${a.comment}）` : ''}`, a.decidedBy === 'human' ? null : a.decidedBy!, a.taskId);

  if (a.kind === 'acceptance' && task) {
    if (a.status === 'approved') {
      store.updateTask(task.id, { status: 'done', feedback: a.comment ?? '' });
    } else {
      store.updateTask(task.id, { status: 'planning', feedback: a.comment || '老板未通过验收' });
      enqueuePlan(task);
    }
  } else if (a.kind === 'question') {
    if (task && task.kind === 'task' && task.status === 'awaiting_human') {
      // 返工超限的裁决
      if (a.status === 'approved') approveTask(task, `老板裁决通过 ${a.comment ?? ''}`, 'human');
      else store.updateTask(task.id, { status: 'changes_requested', feedback: `老板指导：${a.comment || '请继续完善'}`, reviewRounds: 0 });
    } else {
      enqueueJob({
        priority: task?.priority ?? 'P1',
        taskId: a.taskId,
        title: `老板答复 ${a.id}`,
        prompt: `你之前请示老板：\n${a.detail}\n\n老板的决定：${decision}${a.comment ? `\n老板的说明：${a.comment}` : ''}\n\n请据此继续推进（例如派发/调整任务）。${task ? '\n\n' + (task.kind === 'goal' ? goalContext(task) : describeTask(task)) : ''}`,
      });
    }
  }
}
