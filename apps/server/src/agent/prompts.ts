import type { AgentDef, RoleDef, Task } from '@af/shared';
import { company } from '../company.js';
import { config } from '../config.js';
import { store } from '../store.js';

export function buildSystemPrompt(agent: AgentDef, role: RoleDef) {
  const p = company.profile;
  const roster = p.agents.map((a) => `- ${a.name}（${a.id}）：${company.roleName(a.roleId)}，角色 id = ${a.roleId}`).join('\n');
  return `你是「${p.name}」的员工 ${agent.name}，职位：${role.name}。
公司简介：${p.description}

团队成员：
${roster}
老板是人类，负责最终决策。

${role.prompt}

工作环境：
- 共享工作区（所有同事共用同一个项目目录，已初始化 git）：${config.workspace}。文件工具的路径都相对于它。
- 你有自己的终端和浏览器，老板能在你的电脑屏幕上实时看到你在做什么。
- 工作区根目录下的 KNOWLEDGE.md 是公司知识库（规范、决策记录），开始工作前可以先看看。
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
  return `你被分配了任务 ${task.id} [${task.priority}]：${task.title}

任务描述：
${task.description}
${goal ? `\n所属目标 ${goal.id}：${goal.title}\n${goal.description}\n` : ''}${deps ? `\n前置任务的产出：\n${deps}\n` : ''}${task.feedback ? `\n之前的反馈：${task.feedback}\n` : ''}
请开始工作。完成并实际验证后调用 submit_for_review。`;
}
