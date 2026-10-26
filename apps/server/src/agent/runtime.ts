import type { AgentDef, AgentState, RoleDef, ScreenMode, Task } from '@af/shared';
import { bus } from '../bus.js';
import { company } from '../company.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { extractPartialString } from '../llm/partialJson.js';
import type { ChatMessage, LLM, ToolCall } from '../llm/types.js';
import { classifyRisk, getTool, toolsForRole, type ToolContext, type ToolResult } from '../tools/index.js';
import { emitEditor, emitThought } from '../tools/screens.js';
import * as wf from '../workflow.js';
import { buildSystemPrompt, taskBriefing } from './prompts.js';

type Outcome = 'done' | 'preempted' | 'stopped' | 'error';

const TOOL_OUTPUT_LIMIT = 12000;

export class AgentRunner {
  readonly role: RoleDef;
  busy = false;
  /** P0 抢占请求：在下一步边界保存进度并让出 */
  interrupt = false;
  private injected: string[] = [];

  constructor(readonly def: AgentDef, private llm: LLM) {
    this.role = company.role(def.roleId);
  }

  get id() {
    return this.def.id;
  }
  get state(): AgentState {
    return store.agents.get(this.id)!;
  }
  get isManager() {
    return company.isManager(this.id);
  }

  private set(patch: Partial<AgentState>) {
    store.setAgent(this.id, patch);
  }

  private setScreen = (screen: ScreenMode, activity: string) => {
    this.set({ screen, activity, status: 'working' });
  };

  /** 老板插话：忙时插入当前对话，空闲时作为一个新事项 */
  inject(text: string) {
    if (this.busy) {
      this.injected.push(text);
      bus.log('info', `老板对 ${this.def.name} 说：${text}`, this.id);
    } else {
      wf.enqueueJob({ agentId: this.id, priority: 'P1', taskId: null, title: `老板指示 ${Date.now()}`, prompt: `老板直接给你的指示：\n${text}` });
      bus.log('info', `老板给 ${this.def.name} 下达指示：${text}`, this.id);
    }
  }

  private async waitWhilePaused() {
    while (this.state.paused || store.globalPaused) {
      if (this.state.status !== 'paused') this.set({ status: 'paused', activity: '已暂停' });
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---------------- 员工执行任务 ----------------
  async runTask(task: Task) {
    this.busy = true;
    const resumed = store.conversations.get(task.id);
    const wasRework = task.status === 'changes_requested';
    store.updateTask(task.id, { status: 'in_progress', assigneeAgentId: this.id });
    this.set({ currentTaskId: task.id, status: 'thinking', activity: `开始 ${task.id}` });

    let messages: ChatMessage[];
    if (resumed?.length) {
      messages = resumed;
      messages.push({
        role: 'user',
        content: wasRework
          ? `经理打回了你的提交（第 ${task.reviewRounds} 次），意见：\n${task.feedback}\n\n请修改后重新 submit_for_review。`
          : '（你之前被更高优先级的事打断，现在继续完成这个任务。）',
      });
      bus.log('info', wasRework ? `开始返工 ${task.id}` : `继续 ${task.id}`, this.id, task.id);
    } else {
      messages = [
        { role: 'system', content: buildSystemPrompt(this.def, this.role) },
        { role: 'user', content: taskBriefing(task) },
      ];
      bus.log('info', `领取任务 ${task.id} [${task.priority}]：${task.title}`, this.id, task.id);
    }

    const outcome = await this.loop(messages, task.id, task.id);
    const now = store.tasks.get(task.id)!;
    if (outcome === 'preempted') {
      store.updateTask(task.id, { status: 'todo' });
      bus.log('warn', `${task.id} 被更高优先级任务抢占，进度已保存`, this.id, task.id);
    } else if (now.status === 'in_progress') {
      // 员工停止了但没有提交
      wf.reportBlocked(now, this.id, outcome === 'error' ? '执行出错，详见日志' : '员工在未提交的情况下停止了工作，可能需要更明确的指导');
    }
    this.finish();
  }

  // ---------------- 处理事项（经理的规划/评审/审批，或老板指示） ----------------
  async runJob(job: wf.Job) {
    this.busy = true;
    this.set({ currentTaskId: job.taskId, status: 'thinking', activity: job.title });
    bus.log('info', `开始处理：${job.title}`, this.id, job.taskId);
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(this.def, this.role) },
      { role: 'user', content: job.prompt },
    ];
    await this.loop(messages, job.taskId, null);
    this.finish();
  }

  private finish() {
    this.busy = false;
    this.interrupt = false;
    this.injected = [];
    this.set({ status: 'idle', screen: 'idle', currentTaskId: null, activity: '空闲' });
    store.onChangeNotify();
  }

  private async loop(messages: ChatMessage[], taskId: string | null, convKey: string | null): Promise<Outcome> {
    const tools = toolsForRole(this.role.tools);
    const ctx: ToolContext = { agentId: this.id, agentName: this.def.name, taskId, setScreen: this.setScreen };
    let nudged = false;
    const save = () => convKey && store.saveConversation(convKey, messages);

    for (let step = 0; step < config.llm.maxSteps; step++) {
      await this.waitWhilePaused();
      if (this.interrupt) {
        save();
        return 'preempted';
      }
      if (taskId && store.tasks.get(taskId)?.status === 'cancelled') {
        bus.log('warn', `任务 ${taskId} 已取消，停止工作`, this.id, taskId);
        return 'stopped';
      }
      while (this.injected.length) messages.push({ role: 'user', content: `【老板插话】${this.injected.shift()}` });

      // ---- 调用模型（流式：思考过程和正在写的代码实时上屏） ----
      this.set({ status: 'thinking', screen: 'thinking', activity: '思考中…' });
      emitThought(this.id, '', true);
      let lastEditorEmit = 0;
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await this.llm.chat(
            messages,
            tools,
            {
              onText: (d) => emitThought(this.id, d),
              onReasoning: (d) => emitThought(this.id, d),
              onToolArgs: (name, args) => {
                if (name !== 'write_file') return;
                const now = Date.now();
                if (now - lastEditorEmit < 50) return;
                lastEditorEmit = now;
                const p = extractPartialString(args, 'path');
                const c = extractPartialString(args, 'content');
                if (!p?.complete) return;
                if (this.state.screen !== 'editor') this.set({ screen: 'editor', status: 'working', activity: `编写 ${p.value}` });
                emitEditor(this.id, { path: p.value, content: c?.value ?? '', done: false });
              },
            },
            { agentId: this.id, roleId: this.role.id },
          );
          break;
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (attempt >= 3) {
            bus.log('error', `模型调用失败：${msg}`, this.id, taskId);
            this.set({ status: 'error', activity: '模型调用失败' });
            save();
            return 'error';
          }
          bus.log('warn', `模型调用失败，${2 ** attempt * 2}s 后重试：${msg}`, this.id, taskId);
          await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
        }
      }

      const tk = this.state.tokens;
      this.set({ tokens: { input: tk.input + res.usage.input, output: tk.output + res.usage.output } });
      messages.push(res.message);
      if (res.message.content?.trim()) bus.log('debug', `💬 ${res.message.content.trim().slice(0, 300)}`, this.id, taskId);

      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        if (!this.isManager && taskId && !nudged) {
          nudged = true;
          messages.push({ role: 'user', content: '请继续用工具推进任务。完成并验证后调用 submit_for_review；无法继续则调用 report_blocked。' });
          continue;
        }
        save();
        return 'done';
      }

      let ended = false;
      for (const call of calls) {
        const r = await this.execTool(call, ctx);
        messages.push({ role: 'tool', tool_call_id: call.id, content: r.output.length > TOOL_OUTPUT_LIMIT ? r.output.slice(0, TOOL_OUTPUT_LIMIT) + '\n...[输出截断]' : r.output });
        if (r.end) ended = true;
      }
      save();
      if (ended) return 'done';
    }
    bus.log('warn', `超过最大步数 ${config.llm.maxSteps}`, this.id, taskId);
    return 'done';
  }

  private async execTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const name = call.function.name;
    const tool = getTool(name);
    if (!tool) return { output: `错误：没有工具 ${name}` };
    let args: any;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return { output: '错误：参数不是合法 JSON，请重试' };
    }
    bus.log('info', `🔧 ${name} ${summarizeArgs(name, args)}`, this.id, ctx.taskId);

    // ---- 风险审批 ----
    const { risk, reason } = classifyRisk(name, args);
    const needApproval = risk === 'R2' || (risk === 'R1' && !this.isManager);
    if (needApproval) {
      const approver = risk === 'R2' ? 'human' : 'manager';
      const a = store.createApproval({
        kind: 'tool',
        taskId: ctx.taskId,
        requesterId: this.id,
        approver,
        risk,
        title: `${this.def.name} 申请执行 ${name}：${reason}`,
        detail: name === 'run_command' ? args.command : JSON.stringify(args, null, 2),
        tool: name,
        args,
      });
      bus.log('warn', `⏳ ${risk} 操作需${approver === 'human' ? '老板' : '经理'}审批（${reason}）`, this.id, ctx.taskId);
      if (approver === 'manager') {
        wf.enqueueJob({
          priority: 'P0',
          taskId: ctx.taskId,
          title: `审批 ${a.id}`,
          prompt: `员工 ${this.def.name}（${this.role.name}）申请执行一个 ${risk} 风险操作，等待你审批。\n审批 id：${a.id}\n风险原因：${reason}\n所属任务：${ctx.taskId ?? '-'}\n工具：${name}\n内容：\n${a.detail}\n\n请判断是否合理，用 decide_approval 处理（拿不准就 escalate）。`,
        });
      }
      this.set({ status: 'waiting', activity: `等待${approver === 'human' ? '老板' : '经理'}审批` });
      const done = await store.waitApproval(a.id);
      if (done.status !== 'approved') {
        return { output: `操作被${done.decidedBy === 'human' ? '老板' : '经理'}驳回${done.comment ? `：${done.comment}` : ''}。请换一种方式或调整方案。` };
      }
      if (done.comment) args.__note = done.comment;
    }

    this.set({ status: 'working' });
    try {
      const r = await tool.run(ctx, args);
      const out = typeof r === 'string' ? { output: r } : r;
      if (args.__note) out.output = `（审批备注：${args.__note}）\n${out.output}`;
      return out;
    } catch (e: any) {
      bus.log('error', `${name} 失败：${e?.message ?? e}`, this.id, ctx.taskId);
      return { output: `错误：${e?.message ?? e}` };
    }
  }
}

function summarizeArgs(name: string, a: any): string {
  switch (name) {
    case 'run_command':
      return `$ ${a.command}`;
    case 'write_file':
      return `${a.path}（${String(a.content ?? '').split('\n').length} 行）`;
    case 'read_file':
    case 'edit_file':
    case 'list_files':
      return a.path ?? '.';
    case 'browser_open':
      return a.url;
    case 'create_subtask':
      return `[${a.role}] ${a.title}`;
    default: {
      const s = JSON.stringify(a);
      return s.length > 160 ? s.slice(0, 160) + '…' : s;
    }
  }
}
