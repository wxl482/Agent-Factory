import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PRIORITY_ORDER, type Approval, type Priority, type Task } from '@af/shared';
import { bus } from './bus.js';
import { config } from './config.js';
import { db } from './db.js';
import { store } from './store.js';
import { company } from './company.js';
import { roleTable } from './agent/prompts.js';
import { completeAs } from './llm/index.js';
import { usage } from './usage.js';
import { settings } from './settings.js';

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

export function restoreJobs(persisted: Job[]) {
  for (const j of persisted) {
    const num = Number(j.id.replace(/^J/, ''));
    if (Number.isFinite(num)) jobSeq = Math.max(jobSeq, num);
    if (!jobs.some((x) => x.id === j.id || (x.agentId === j.agentId && x.title === j.title && x.taskId === j.taskId))) {
      jobs.push(j);
    }
  }
  jobs.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt);
}

export function enqueueJob(j: Omit<Job, 'id' | 'createdAt' | 'agentId'> & { agentId?: string }) {
  const job: Job = { ...j, agentId: j.agentId ?? company.managerAgentId(), id: `J${++jobSeq}`, createdAt: Date.now() };
  // 同一任务同类事项不重复排队
  if (jobs.some((x) => x.agentId === job.agentId && x.title === job.title && x.taskId === job.taskId)) return;
  jobs.push(job);
  jobs.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt);
  db.upsertJob(job);
  bus.log('debug', `新事项排队：${job.title}`, job.agentId, job.taskId);
  store.onChangeNotify();
}

export function takeJob(agentId: string): Job | null {
  // 超预算暂停中的目标，相关事项先不处理，免得把经理卡住
  const i = jobs.findIndex((j) => j.agentId === agentId && !usage.isGoalHeld(j.taskId));
  if (i < 0) return null;
  const [taken] = jobs.splice(i, 1);
  db.deleteJob(taken.id);
  return taken;
}

export function peekJob(agentId: string) {
  return jobs.find((j) => j.agentId === agentId && !usage.isGoalHeld(j.taskId)) ?? null;
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
  const notes = goal.notes.length ? `\n会议纪要：\n${goal.notes.join('\n---\n')}\n` : '';
  return `目标 ${goal.id} [${goal.priority}]：${goal.title}\n目标描述：${goal.description || '(无)'}\n${
    goal.feedback ? `老板最近的反馈：${goal.feedback}\n` : ''
  }${notes}\n当前子任务：\n${kids.map(describeTask).join('\n') || '(暂无)'}`;
}

export function addGoalNote(goalId: string | null, note: string) {
  const goal = goalId ? store.tasks.get(goalId) : undefined;
  const g = goal?.kind === 'task' && goal.parentId ? store.tasks.get(goal.parentId) : goal;
  if (g) store.updateTask(g.id, { notes: [...g.notes, note] });
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
    prompt: `${goalContext(goal)}\n\n请按「规划目标的标准步骤」高效处理：\n1. 判断最终交付物属于哪个岗位（对照岗位职责表，产出物决定归属）。\n2. **区分轻重，避免过度拆解与盲目读文件**：\n   - 若目标是独立创作/单一交付物（如写一篇文案/文章、做一份调研、写一个独立小工具）且未要求基于工作区已有代码改造，**严禁调用 list_files / read_file 翻阅工作区旧文档，也不要开会**，直接一步调用 create_subtask 派给对应角色即可。\n   - 只有涉及多岗位协作或需要改造工作区现有项目时，才查看相关目录或召集简短会议。\n3. acceptance（验收标准）控制在 2~4 条核心要求即可，聚焦内容质量与老板意图，**严禁设置苛刻的字数卡点（字数允许 ±15% 浮动）或要求在交付文件内写自查表/统计口径**。`,
  });
}

/** 典型任务关键词快速放行：命中明确归属时免去一次 LLM 派单审核调用 */
const FAST_ROUTE_RULES: Record<string, { match: RegExp; forbid: RegExp }> = {
  content: { match: /文案|小红书|公众号|微博|抖音|即刻|笔记|推文|文章|软文|介绍|公告|教程|FAQ|slogan|话术|写一篇/i, forbid: /编写代码|开发网页|自动化测试脚本/i },
  dev: { match: /开发|代码|实现|网页|前端|后端|接口|组件|修复|bug|脚本|应用|页面/i, forbid: /小红书文案|公众号推文/i },
  qa: { match: /测试|用例|验证|回归|缺陷复现|测试报告/i, forbid: /开发新功能|写营销文案/i },
  pm: { match: /PRD|需求文档|功能清单|交互说明|原型设计/i, forbid: /写代码|小红书文案/i },
  growth: { match: /调研|竞品|增长|投放|数据分析|渠道策略|市场分析/i, forbid: /开发前端页面/i },
};

/**
 * 派单校验：先用零成本规则快速放行典型派单；存疑时再让模型以“派单审核员”身份复核。
 * 校验本身出错时放行（不能因为校验服务异常阻塞业务）。
 */
async function checkRouting(goal: Task, a: { title: string; description: string; role: string }) {
  const rule = FAST_ROUTE_RULES[a.role];
  const combined = `${a.title}\n${a.description}`;
  if (rule && rule.match.test(combined) && !rule.forbid.test(combined)) {
    return { ok: true as const };
  }
  const mgr = company.managerAgentId();
  try {
    const text = await completeAs(mgr, company.profile.managerRoleId, {
      kind: 'route_check',
      json: true,
      maxTokens: 300,
      system: `你是派单审核员。根据岗位职责表，判断一个子任务是否派给了正确的岗位。判断依据是任务的产出物属于哪个岗位的职责，不考虑谁有空。只输出 JSON：{"ok": true} 或 {"ok": false, "suggest": "<正确的角色 id>", "reason": "<一句话理由>"}。\n\n${roleTable()}`,
      user: `目标：${goal.title}\n${goal.description}\n\n子任务：${a.title}\n描述：${a.description}\n拟派给角色：${a.role}（${company.roleName(a.role)}）`,
    });
    const json = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? '{}');
    if (json.ok === false && typeof json.suggest === 'string' && json.suggest !== a.role) {
      return { ok: false as const, suggest: json.suggest as string, reason: String(json.reason ?? '') };
    }
  } catch (e: any) {
    bus.log('debug', `派单校验跳过：${e?.message ?? e}`, mgr);
  }
  return { ok: true as const };
}

export async function createSubtask(
  goalId: string,
  a: { title: string; description: string; role: string; acceptance?: string; priority?: Priority; depends_on?: string[]; force?: boolean; force_reason?: string },
) {
  const goal = store.tasks.get(goalId);
  if (!goal) throw new Error(`目标 ${goalId} 不存在`);
  if (!company.workerRoles().some((r) => r.id === a.role)) throw new Error(`角色 ${a.role} 不存在，可选：${company.workerRoles().map((r) => `${r.id}(${r.name})`).join(', ')}`);
  if (!a.acceptance?.trim()) throw new Error('缺少 acceptance（验收标准），请补充可逐条检查的验收标准后重新派发');
  if (!a.force) {
    const check = await checkRouting(goal, a);
    if (!check.ok) {
      bus.log('warn', `派单校验拦截「${a.title}」→ ${company.roleName(a.role)}：${check.reason}，建议 ${company.roleName(check.suggest)}`, company.managerAgentId(), goalId);
      throw new Error(`派单被拦截：${check.reason}。建议派给 ${check.suggest}（${company.roleName(check.suggest)}）。如果你确认原派法正确，可加 force=true 并在 force_reason 说明理由。`);
    }
  } else {
    bus.log('warn', `经理强制派单「${a.title}」→ ${company.roleName(a.role)}：${a.force_reason ?? '未说明理由'}`, company.managerAgentId(), goalId);
  }
  const deps = (a.depends_on ?? []).filter((d) => store.tasks.has(d));
  const t = store.createTask({
    kind: 'task',
    title: a.title,
    description: a.description,
    acceptance: a.acceptance,
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

/** 自动扫描 git 工作区在任务开始后新增/修改的文件（补齐 run_command 命令行生成的产物） */
export function captureWorktreeArtifacts(task: Task) {
  try {
    const out = execSync('git status --porcelain -uall', { cwd: config.workspace, encoding: 'utf8', timeout: 3000 });
    const since = (task.startedAt ?? task.createdAt) - 2000;
    for (const line of out.split('\n')) {
      if (line.length < 4) continue;
      let relPath = line.slice(3).trim();
      if (relPath.includes(' -> ')) relPath = relPath.split(' -> ').pop()!.trim();
      relPath = relPath.replace(/^"+|"+$/g, '');
      if (!relPath || relPath === 'KNOWLEDGE.md' || relPath.startsWith('docs/meetings/')) continue;
      if (/^(\.tmp|node_modules|\.git|dist|\.next|__pycache__)(\/|-|$)/.test(relPath)) continue;
      try {
        const st = fs.statSync(path.join(config.workspace, relPath));
        if (st.isFile() && st.mtimeMs >= since) {
          store.addArtifact(task.id, relPath);
        }
      } catch {}
    }
  } catch {}
}

/** 读取文本类产出物的预览和系统实测字数，直接附在评审提示词里，省去经理再调工具读文件/跑脚本 */
function inlineTextArtifacts(task: Task): { preview: string; allText: boolean } {
  if (!task.artifacts.length) return { preview: '', allText: false };
  const blocks: string[] = [];
  let allText = true;
  for (const relPath of task.artifacts.slice(0, 3)) {
    if (!/\.(md|txt)$/i.test(relPath)) {
      allText = false;
      continue;
    }
    try {
      const content = fs.readFileSync(path.join(config.workspace, relPath), 'utf8');
      const noWs = [...content.replace(/\s+/g, '')].length;
      const hanzi = (content.match(/[\u4e00-\u9fa5]/g) ?? []).length;
      const body = content.length > 4500 ? content.slice(0, 4500) + '\n...[截断]' : content;
      blocks.push(`### 产出文件：${relPath}（系统实测：去空白 ${noWs} 字符 / ${hanzi} 汉字）\n\`\`\`markdown\n${body}\n\`\`\``);
    } catch {
      allText = false;
    }
  }
  return { preview: blocks.length ? `\n\n## 系统自动附上的产出文件内容\n${blocks.join('\n\n')}` : '', allText: allText && blocks.length > 0 };
}

export function submitForReview(task: Task, agentId: string, summary: string, selfCheck = '') {
  captureWorktreeArtifacts(task);
  if (selfCheck) summary = `${summary}\n\n自查：\n${selfCheck}`;
  store.updateTask(task.id, { status: 'review', result: summary });
  bus.log('success', `提交评审 ${task.id}：${summary.slice(0, 120)}`, agentId, task.id);
  const { preview, allText } = inlineTextArtifacts(task);
  const howToReview = allText
    ? '产出文件全文与系统实测字数已直接附在上方。**请直接审阅并一步调用 approve_task（或 request_changes），禁止再调用 read_file 或 run_command 跑脚本测字数**；字数有合理浮动（±15%）一律放行。'
    : '请对照验收标准检查产出（必要时 read_file 或 run_command 验证），然后调用 approve_task 或 request_changes。';
  enqueueJob({
    priority: task.priority,
    taskId: task.id,
    title: `评审 ${task.id}`,
    prompt: `${company.agentName(agentId)} 提交了任务，请评审。\n\n任务 ${task.id}：${task.title}\n任务描述：${task.description}\n验收标准：\n${task.acceptance || '（未列出）'}\n已返工次数：${task.reviewRounds}\n\n员工的工作总结：\n${summary}${preview}\n\n${
      task.parentId ? goalContext(store.tasks.get(task.parentId)!) : ''
    }\n\n${howToReview}`,
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

/** 员工认为任务不属于自己的岗位，退回经理改派 */
export function rejectAssignment(task: Task, agentId: string, reason: string, suggestedRole?: string) {
  store.updateTask(task.id, { status: 'blocked', assigneeAgentId: null, result: `退单：${reason}` });
  store.deleteConversation(task.id);
  bus.log('warn', `退单 ${task.id}：${reason}${suggestedRole ? `（建议 ${company.roleName(suggestedRole)}）` : ''}`, agentId, task.id);
  enqueueJob({
    priority: task.priority,
    taskId: task.id,
    title: `处理退单 ${task.id}`,
    prompt: `${company.agentName(agentId)}（${company.roleName(company.profile.agents.find((x) => x.id === agentId)!.roleId)}）认为任务不属于自己的岗位，退回了任务。\n任务 ${task.id}：${task.title}\n描述：${task.description}\n退单理由：${reason}\n建议岗位：${suggestedRole ? `${suggestedRole}（${company.roleName(suggestedRole)}）` : '未给出'}\n\n对照岗位职责表判断：理由成立就用 reassign_task 改派；不成立就用 request_changes 说明为什么该由他做。`,
  });
}

export function reassignTask(task: Task, role: string, note: string, by: string) {
  if (!company.workerRoles().some((r) => r.id === role)) throw new Error(`角色 ${role} 不存在`);
  store.deleteConversation(task.id);
  store.updateTask(task.id, { status: 'todo', assigneeRoleId: role, assigneeAgentId: null, feedback: note, reviewRounds: 0 });
  bus.log('info', `改派 ${task.id} 给${company.roleName(role)}${note ? `：${note}` : ''}`, by, task.id);
}

/** 老板在交付页直接针对某个产出文件发起「局部微调」，直接唤醒原执行员工快速修改，免走全套重规划 */
export function reviseGoalArtifact(goal: Task, instruction: string, filePath?: string) {
  const kids = store.children(goal.id);
  const targetTask =
    (filePath ? kids.find((k) => k.artifacts.includes(filePath)) : undefined) ??
    [...kids].reverse().find((k) => k.status === 'done') ??
    kids[kids.length - 1];
  // 若有挂起的交付验收审批，自动关闭
  for (const a of store.approvals.values()) {
    if (a.status === 'pending' && a.kind === 'acceptance' && a.taskId === goal.id) {
      store.decideApproval(a.id, false, 'human', `局部微调：${instruction}`);
      break;
    }
  }
  if (!targetTask) {
    store.updateTask(goal.id, { status: 'planning', feedback: instruction });
    enqueuePlan(goal);
    return null;
  }
  const promptNote = `【老板局部微调指示】${filePath ? `针对文件 ${filePath}：` : ''}${instruction}\n请只针对上述意见快速修改对应文件，完成后立即调用 submit_for_review 提交，不要重做无关内容。`;
  store.updateTask(goal.id, { status: 'in_progress', feedback: instruction });
  store.updateTask(targetTask.id, { status: 'changes_requested', feedback: promptNote });
  bus.log('info', `老板发起局部微调 ${targetTask.id}${filePath ? ` (${filePath})` : ''}：${instruction}`, null, goal.id);
  return targetTask;
}

export function approveTask(task: Task, comment: string, by: string, goalSummary?: string) {
  store.updateTask(task.id, { status: 'done', feedback: comment });
  bus.log('success', `评审通过 ${task.id}${comment ? `：${comment}` : ''}`, by, task.id);
  checkGoal(task.parentId, goalSummary);
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

export function checkGoal(goalId: string | null, goalSummary?: string) {
  if (!goalId) return;
  const goal = store.tasks.get(goalId);
  if (!goal || goal.status === 'done' || goal.status === 'awaiting_human') return;
  const kids = store.children(goalId);
  if (kids.length && kids.every((k) => k.status === 'done' || k.status === 'cancelled')) {
    const doneKids = kids.filter((k) => k.status === 'done');
    // 单一子任务目标或经理已在 approve_task 中附带 goal_summary 时，直接完成目标交付，省去一整轮「交付目标」LLM 调用
    if (goalSummary?.trim() || doneKids.length === 1) {
      const only = doneKids[0];
      const files = only?.artifacts.length ? `产出文件：${only.artifacts.join('、')}\n\n` : '';
      const cleanResult = only?.result.split('\n\n自查：')[0]?.trim() ?? '';
      const summary = goalSummary?.trim() || (only ? `${files}${cleanResult}${only.feedback ? `\n\n评审意见：${only.feedback}` : ''}` : '所有子任务均已完成。');
      finalizeGoal(goal, summary, company.managerAgentId());
      return;
    }
    enqueueJob({
      priority: goal.priority,
      taskId: goal.id,
      title: `交付目标 ${goal.id}`,
      prompt: `${goalContext(goal)}\n\n所有子任务均已完成。请直接调用 finalize_goal 写简明交付总结（产出在哪、怎么使用/运行、遗留问题）。`,
    });
  }
}

export function finalizeGoal(goal: Task, summary: string, by: string) {
  store.updateTask(goal.id, { result: summary });
  if (settings.get().approval.humanAcceptance) {
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

  // 预算请示：系统发起，直接处理，不再转给经理
  if (a.budget) {
    const ok = a.status === 'approved';
    if (a.budget.scope === 'daily') usage.grantDaily(ok);
    else if (a.budget.goalId) {
      usage.grantGoal(a.budget.goalId, ok);
      const goal = store.tasks.get(a.budget.goalId);
      if (!ok && goal && goal.status !== 'done' && goal.status !== 'cancelled') {
        for (const k of store.children(goal.id)) if (k.status !== 'done' && k.status !== 'cancelled') cancelTask(k, '目标超预算，老板决定停止', 'human');
        cancelTask(goal, '超出单目标预算，老板决定停止', 'human');
      }
    }
    return;
  }

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
