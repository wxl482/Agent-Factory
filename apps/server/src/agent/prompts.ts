import type { AgentDef, RoleDef, Task } from '@af/shared';
import { company } from '../company.js';
import { config } from '../config.js';
import { buildRoleSkillsPrompt } from '../skills.js';
import { store } from '../store.js';

/** 岗位职责表：经理派单、派单校验、员工判断是否该接这个活，都以它为准 */
export function roleTable(includeManager = false) {
  const p = company.profile;
  return p.roles
    .filter((r) => includeManager || r.id !== p.managerRoleId)
    .map((r) => {
      const people = p.agents.filter((a) => a.roleId === r.id).map((a) => `${a.name}(${a.id})`).join('、');
      const lines = [`### ${r.name}（角色 id: ${r.id}；成员：${people || '无'}）`];
      if (r.description) lines.push(r.description);
      if (r.responsibilities?.length) lines.push(`负责：${r.responsibilities.join('；')}`);
      if (r.outOfScope?.length) lines.push(`不负责：${r.outOfScope.join('；')}`);
      if (r.deliverables?.length) lines.push(`交付物：${r.deliverables.join('；')}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function buildSystemPrompt(agent: AgentDef, role: RoleDef) {
  const p = company.profile;
  const isManager = role.id === p.managerRoleId;
  const managerName = company.agentName(company.managerAgentId());
  const collab = isManager
    ? `协作工具：call_meeting（召集同事开会对齐）、talk_to（把某位员工叫到经理室谈话）。`
    : `协作规范：
- 任务不属于你的岗位职责（对照下方职责表），立刻用 reject_assignment 退回并说明应由哪个岗位负责，不要硬做。
- 需求不清、需要决策时，用 ask_manager 去经理室当面请示 ${managerName}；需要别的岗位的信息时，用 ask_colleague 去对方工位问。不要凭空猜测。
- 提交前对照验收标准逐条自查，submit_for_review 的 self_check 里写明每条是否达成。`;

  return `你是「${p.name}」的员工 ${agent.name}，职位：${role.name}。
公司简介：${p.description}
老板是人类，负责最终决策。

${role.prompt}${buildRoleSkillsPrompt(role)}

## 岗位职责表
${roleTable(true)}

## ${collab}

## 工作环境
- 共享工作区（所有同事共用同一个项目目录，已初始化 git）：${config.workspace}。文件工具的路径都相对于它。
- 你有自己的终端和浏览器，老板能在你的电脑屏幕上实时看到你在做什么。
- 工作区根目录下的 KNOWLEDGE.md 是公司知识库，docs/meetings/ 下是会议纪要。
- 高风险操作（安装依赖、删除文件、对外发布等）会自动发起审批，等批准后才执行，被驳回就换个方案。
- 用中文思考和沟通，言简意赅。每次调用工具前，用一句话说明你要做什么。
- 当前时间：${new Date().toLocaleString('zh-CN')}`;
}

export function taskBriefing(task: Task) {
  const goal = task.parentId ? store.tasks.get(task.parentId) : undefined;
  const deps = task.dependsOn
    .map((id) => store.tasks.get(id))
    .filter(Boolean)
    .map((d) => `- ${d!.id}（${company.agentName(d!.assigneeAgentId ?? '')}）${d!.title}\n  产出总结：${d!.result || '(无)'}`)
    .join('\n');
  const notes = goal?.notes.length ? `\n相关会议纪要：\n${goal.notes.map((n) => `> ${n.replace(/\n/g, '\n> ')}`).join('\n\n')}\n` : '';
  return `你被分配了任务 ${task.id} [${task.priority}]：${task.title}

任务描述：
${task.description}

验收标准：
${task.acceptance || '（未单独列出，以任务描述为准）'}
${goal ? `\n所属目标 ${goal.id}：${goal.title}\n${goal.description}\n` : ''}${notes}${deps ? `\n前置任务的产出：\n${deps}\n` : ''}${task.feedback ? `\n之前的反馈：${task.feedback}\n` : ''}
先确认这个任务属于你的岗位职责；属于就开始工作，完成并实际验证后调用 submit_for_review。`;
}
