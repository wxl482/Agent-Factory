import fs from 'node:fs';
import path from 'node:path';
import type { Priority, Risk, ScreenMode, ToolGroup } from '@af/shared';
import { config } from '../config.js';
import { company } from '../company.js';
import { store } from '../store.js';
import * as wf from '../workflow.js';
import type { ToolSpec } from '../llm/types.js';
import { getBrowserFor } from './browser.js';
import { emitEditor } from './screens.js';
import { getTerminal } from './terminal.js';

export interface ToolContext {
  agentId: string;
  agentName: string;
  taskId: string | null;
  setScreen(mode: ScreenMode, activity: string): void;
}

export interface ToolResult {
  output: string;
  /** 结束当前工作单元 */
  end?: boolean;
}

interface ToolDef {
  group: ToolGroup[];
  spec: ToolSpec;
  run(ctx: ToolContext, args: any): Promise<ToolResult | string>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });

function inWorkspace(p: string) {
  const abs = path.resolve(config.workspace, p || '.');
  if (abs !== config.workspace && !abs.startsWith(config.workspace + path.sep)) throw new Error(`路径 ${p} 超出工作区，不允许访问`);
  return abs;
}

function rel(abs: string) {
  return path.relative(config.workspace, abs) || '.';
}

const IGNORE = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv']);

function listTree(dir: string, depth: number, prefix = '', out: string[] = []) {
  if (out.length > 300) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (IGNORE.has(e.name)) {
      out.push(`${prefix}${e.name}/ (已忽略)`);
      continue;
    }
    out.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
    if (e.isDirectory() && depth > 1) listTree(path.join(dir, e.name), depth - 1, prefix + '  ', out);
  }
  return out;
}

function currentTask(ctx: ToolContext) {
  const t = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
  if (!t) throw new Error('当前没有关联的任务');
  return t;
}

function taskById(id: string) {
  const t = store.tasks.get(id);
  if (!t) throw new Error(`任务 ${id} 不存在`);
  return t;
}

const TOOLS: Record<string, ToolDef> = {
  // ---------------- 文件 ----------------
  list_files: {
    group: ['fs', 'fs_read'],
    spec: { name: 'list_files', description: '列出工作区目录树', parameters: obj({ path: str('相对工作区的目录，默认 .'), depth: int('深度，默认 3') }) },
    async run(ctx, a) {
      const abs = inWorkspace(a.path ?? '.');
      ctx.setScreen('editor', `浏览目录 ${rel(abs)}`);
      const tree = listTree(abs, a.depth ?? 3);
      emitEditor(ctx.agentId, { path: `${rel(abs)}/`, content: tree.join('\n') || '(空目录)', done: true });
      return tree.join('\n') || '(空目录)';
    },
  },
  read_file: {
    group: ['fs', 'fs_read'],
    spec: { name: 'read_file', description: '读取文件内容（带行号）', parameters: obj({ path: str('相对工作区的文件路径'), start_line: int('起始行，可选'), end_line: int('结束行，可选') }, ['path']) },
    async run(ctx, a) {
      const abs = inWorkspace(a.path);
      ctx.setScreen('editor', `阅读 ${rel(abs)}`);
      const content = fs.readFileSync(abs, 'utf8');
      emitEditor(ctx.agentId, { path: rel(abs), content, done: true });
      const lines = content.split('\n');
      const s = Math.max(1, a.start_line ?? 1);
      const e = Math.min(lines.length, a.end_line ?? s + 499);
      const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(4)}| ${l}`).join('\n');
      return e < lines.length ? `${body}\n...（共 ${lines.length} 行，可用 start_line 继续读）` : body;
    },
  },
  write_file: {
    group: ['fs'],
    spec: { name: 'write_file', description: '创建或覆盖文件（自动创建目录）', parameters: obj({ path: str('相对工作区的文件路径'), content: str('完整文件内容') }, ['path', 'content']) },
    async run(ctx, a) {
      const abs = inWorkspace(a.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, a.content);
      emitEditor(ctx.agentId, { path: rel(abs), content: a.content, done: true });
      return `已写入 ${rel(abs)}（${a.content.split('\n').length} 行）`;
    },
  },
  edit_file: {
    group: ['fs'],
    spec: {
      name: 'edit_file',
      description: '精确替换文件中的一段文本（old_string 必须在文件中唯一出现）',
      parameters: obj({ path: str('文件路径'), old_string: str('要替换的原文'), new_string: str('替换后的文本') }, ['path', 'old_string', 'new_string']),
    },
    async run(ctx, a) {
      const abs = inWorkspace(a.path);
      ctx.setScreen('editor', `修改 ${rel(abs)}`);
      const src = fs.readFileSync(abs, 'utf8');
      const n = src.split(a.old_string).length - 1;
      if (n !== 1) throw new Error(`old_string 在文件中出现了 ${n} 次，需要唯一匹配`);
      const next = src.replace(a.old_string, () => a.new_string);
      fs.writeFileSync(abs, next);
      emitEditor(ctx.agentId, { path: rel(abs), content: next, done: true });
      return `已修改 ${rel(abs)}`;
    },
  },

  // ---------------- 终端 ----------------
  run_command: {
    group: ['terminal'],
    spec: {
      name: 'run_command',
      description: '在你自己的终端（bash，工作目录为共享工作区）执行命令并返回输出。常驻服务请用 nohup ... & 后台启动。',
      parameters: obj({ command: str('要执行的命令'), timeout_sec: int('超时秒数，默认 120，最大 600') }, ['command']),
    },
    async run(ctx, a) {
      ctx.setScreen('terminal', `$ ${a.command.split('\n')[0].slice(0, 60)}`);
      const r = await getTerminal(ctx.agentId, ctx.agentName).run(a.command, Math.min(a.timeout_sec ?? 120, 600));
      const head = r.timedOut ? '[超时，已发送 Ctrl-C]' : `[退出码 ${r.exitCode}]`;
      return `${head}\n${r.output || '(无输出)'}`;
    },
  },
  terminal_input: {
    group: ['terminal'],
    spec: { name: 'terminal_input', description: '向终端发送原始按键，例如回答交互式提问 "y\\n"，或 Ctrl-C "\\u0003"', parameters: obj({ text: str('要输入的内容') }, ['text']) },
    async run(ctx, a) {
      ctx.setScreen('terminal', '终端输入');
      const t = getTerminal(ctx.agentId, ctx.agentName);
      const before = t.buffer.length;
      t.input(a.text);
      await new Promise((r) => setTimeout(r, 1500));
      return `已发送。终端新输出：\n${t.buffer.slice(before).slice(-3000)}`;
    },
  },

  // ---------------- 浏览器 ----------------
  browser_open: {
    group: ['browser'],
    spec: { name: 'browser_open', description: '在你的浏览器打开网址，或工作区内的 html 文件路径', parameters: obj({ url: str('网址或工作区内文件路径') }, ['url']) },
    async run(ctx, a) {
      ctx.setScreen('browser', `打开 ${a.url}`);
      return getBrowserFor(ctx.agentId).open(a.url);
    },
  },
  browser_read: {
    group: ['browser'],
    spec: { name: 'browser_read', description: '读取当前页面的文字和可交互元素编号', parameters: obj({}) },
    async run(ctx) {
      ctx.setScreen('browser', '阅读网页');
      return getBrowserFor(ctx.agentId).read();
    },
  },
  browser_click: {
    group: ['browser'],
    spec: {
      name: 'browser_click',
      description: '点击页面元素（优先用 browser_read 给出的 index）',
      parameters: obj({ index: int('元素编号'), text: str('按可见文字定位'), selector: str('CSS 选择器') }),
    },
    async run(ctx, a) {
      ctx.setScreen('browser', `点击 ${a.text ?? a.selector ?? '#' + a.index}`);
      return getBrowserFor(ctx.agentId).click(a);
    },
  },
  browser_type: {
    group: ['browser'],
    spec: {
      name: 'browser_type',
      description: '在输入框中输入文字',
      parameters: obj({ index: int('元素编号'), selector: str('CSS 选择器'), value: str('要输入的文字'), submit: { type: 'boolean', description: '输入后回车' } }, ['value']),
    },
    async run(ctx, a) {
      ctx.setScreen('browser', `输入 ${String(a.value).slice(0, 30)}`);
      return getBrowserFor(ctx.agentId).type(a);
    },
  },
  browser_back: {
    group: ['browser'],
    spec: { name: 'browser_back', description: '浏览器后退', parameters: obj({}) },
    async run(ctx) {
      ctx.setScreen('browser', '后退');
      return getBrowserFor(ctx.agentId).back();
    },
  },

  // ---------------- 员工 ----------------
  submit_for_review: {
    group: ['worker'],
    spec: { name: 'submit_for_review', description: '完成任务后提交给经理评审', parameters: obj({ summary: str('工作总结：做了什么、产出文件、如何验证') }, ['summary']) },
    async run(ctx, a) {
      wf.submitForReview(currentTask(ctx), ctx.agentId, a.summary);
      return { output: '已提交评审', end: true };
    },
  },
  report_blocked: {
    group: ['worker'],
    spec: { name: 'report_blocked', description: '遇到无法自行解决的问题时上报经理', parameters: obj({ reason: str('受阻原因和需要的帮助') }, ['reason']) },
    async run(ctx, a) {
      wf.reportBlocked(currentTask(ctx), ctx.agentId, a.reason);
      return { output: '已上报', end: true };
    },
  },

  // ---------------- 经理 ----------------
  create_subtask: {
    group: ['manager'],
    spec: {
      name: 'create_subtask',
      description: '在目标下创建子任务并派发给某个角色',
      parameters: obj(
        {
          title: str('任务标题'),
          description: str('详细描述，包括验收标准'),
          role: str('负责角色 id'),
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: '默认继承目标优先级' },
          depends_on: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id，完成后才开始' },
          goal_id: str('目标 id，默认当前目标'),
        },
        ['title', 'description', 'role'],
      ),
    },
    async run(ctx, a) {
      let goalId = a.goal_id ?? ctx.taskId;
      const t = goalId ? store.tasks.get(goalId) : undefined;
      if (t?.kind === 'task') goalId = t.parentId;
      if (!goalId) throw new Error('请提供 goal_id');
      const sub = wf.createSubtask(goalId, a);
      return `已创建 ${sub.id}`;
    },
  },
  list_tasks: {
    group: ['manager'],
    spec: { name: 'list_tasks', description: '查看所有未完成的目标和任务', parameters: obj({}) },
    async run() {
      const all = [...store.tasks.values()].filter((t) => !['done', 'cancelled'].includes(t.status));
      return all.map(wf.describeTask).join('\n') || '(没有进行中的任务)';
    },
  },
  approve_task: {
    group: ['manager'],
    spec: { name: 'approve_task', description: '评审通过任务', parameters: obj({ task_id: str('任务 id'), comment: str('评语') }, ['task_id']) },
    async run(ctx, a) {
      wf.approveTask(taskById(a.task_id), a.comment ?? '', ctx.agentId);
      return { output: '已通过', end: true };
    },
  },
  request_changes: {
    group: ['manager'],
    spec: { name: 'request_changes', description: '打回任务并给出具体修改意见', parameters: obj({ task_id: str('任务 id'), feedback: str('具体修改意见') }, ['task_id', 'feedback']) },
    async run(ctx, a) {
      const r = wf.requestChanges(taskById(a.task_id), a.feedback, ctx.agentId);
      return { output: r === 'escalated' ? '返工次数超限，已自动升级给老板裁决' : '已打回', end: true };
    },
  },
  cancel_task: {
    group: ['manager'],
    spec: { name: 'cancel_task', description: '取消任务', parameters: obj({ task_id: str('任务 id'), reason: str('原因') }, ['task_id', 'reason']) },
    async run(ctx, a) {
      wf.cancelTask(taskById(a.task_id), a.reason, ctx.agentId);
      return '已取消';
    },
  },
  decide_approval: {
    group: ['manager'],
    spec: {
      name: 'decide_approval',
      description: '处理员工的操作审批申请',
      parameters: obj(
        { approval_id: str('审批 id'), decision: { type: 'string', enum: ['approve', 'reject', 'escalate'], description: 'escalate=交给老板' }, comment: str('理由') },
        ['approval_id', 'decision'],
      ),
    },
    async run(ctx, a) {
      if (a.decision === 'escalate') {
        store.escalateApproval(a.approval_id, a.comment ?? '');
        return { output: '已转交老板', end: true };
      }
      const r = store.decideApproval(a.approval_id, a.decision === 'approve', ctx.agentId, a.comment ?? '');
      if (!r) throw new Error('审批不存在或已处理');
      return { output: '已处理', end: true };
    },
  },
  escalate_to_human: {
    group: ['manager'],
    spec: {
      name: 'escalate_to_human',
      description: '请示老板（重要决策、拿不准、涉及花钱/对外发布/不可逆）',
      parameters: obj({ question: str('问题和背景，写清楚选项利弊'), options: { type: 'array', items: { type: 'string' }, description: '可选方案' } }, ['question']),
    },
    async run(ctx, a) {
      const ap = wf.escalateToHuman(ctx.agentId, ctx.taskId, a.question, a.options ?? []);
      return { output: `已请示老板（${ap.id}），老板答复后你会收到新的事项`, end: true };
    },
  },
  finalize_goal: {
    group: ['manager'],
    spec: { name: 'finalize_goal', description: '目标完成，向老板提交交付总结', parameters: obj({ goal_id: str('目标 id'), summary: str('交付总结') }, ['goal_id', 'summary']) },
    async run(ctx, a) {
      wf.finalizeGoal(taskById(a.goal_id), a.summary, ctx.agentId);
      return { output: '已提交老板验收', end: true };
    },
  },
};

export function toolsForRole(groups: ToolGroup[]): ToolSpec[] {
  return Object.values(TOOLS)
    .filter((t) => t.group.some((g) => groups.includes(g)))
    .map((t) => t.spec);
}

export function getTool(name: string) {
  return TOOLS[name];
}

/** 按公司风险规则判定工具调用的风险等级 */
export function classifyRisk(tool: string, args: any): { risk: Risk; reason: string } {
  const subject = tool === 'run_command' ? String(args?.command ?? '') : JSON.stringify(args ?? {});
  let best: { risk: Risk; reason: string } = { risk: 'R0', reason: '' };
  for (const r of company.profile.policy.rules) {
    if (r.tool !== tool && r.tool !== '*') continue;
    if (r.pattern && !new RegExp(r.pattern, 'i').test(subject)) continue;
    if (r.risk > best.risk) best = { risk: r.risk, reason: r.reason };
  }
  return best;
}

export type { Priority };
