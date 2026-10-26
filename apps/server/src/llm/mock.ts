import type { ChatMessage, LLM, LLMContext, LLMResult, StreamCallbacks, ToolCall } from './types.js';

/**
 * 演示模式（无 API Key 时启用）：按剧本决定调用哪些工具，
 * 但工具全部真实执行——终端真跑命令、浏览器真打开页面、代码逐字写入文件。
 */

interface Step {
  text: string;
  calls?: { name: string; args: Record<string, unknown> }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COUNTER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>像素计数器</title>
  <style>
    body { margin: 0; height: 100vh; display: grid; place-items: center;
           background: #1b1f3a; color: #f4e9cd; font-family: monospace; }
    .card { padding: 32px 48px; border: 4px solid #f4e9cd; box-shadow: 8px 8px 0 #000;
            background: #2d3561; text-align: center; }
    h1 { margin: 0 0 16px; font-size: 22px; letter-spacing: 2px; }
    #count { font-size: 96px; margin: 8px 0 24px; color: #ffd166; }
    button { font: inherit; font-size: 20px; padding: 8px 20px; margin: 0 6px;
             border: 3px solid #000; background: #06d6a0; cursor: pointer; box-shadow: 4px 4px 0 #000; }
    button.reset { background: #ef476f; color: #fff; }
  </style>
</head>
<body>
  <div class="card">
    <h1>PIXEL COUNTER</h1>
    <div id="count">0</div>
    <button id="dec">-1</button>
    <button id="inc">+1</button>
    <button id="reset" class="reset">重置</button>
  </div>
  <script src="app.js"></script>
</body>
</html>
`;

const COUNTER_JS = `// 像素计数器：支持加减、重置，并持久化到 localStorage
const KEY = 'pixel-counter';
const el = document.getElementById('count');

function load() {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}

let count = load();

function render() {
  el.textContent = String(count);
  el.style.color = count < 0 ? '#ef476f' : '#ffd166';
  try {
    localStorage.setItem(KEY, String(count));
  } catch {}
}

document.getElementById('inc').onclick = () => { count += 1; render(); };
document.getElementById('dec').onclick = () => { count -= 1; render(); };
document.getElementById('reset').onclick = () => { count = 0; render(); };

render();
`;

const COUNTER_TEST = `// 计数器冒烟测试：校验页面结构和脚本逻辑
import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('app/index.html', 'utf8');
const js = fs.readFileSync('app/app.js', 'utf8');

const checks = [
  ['存在计数显示区域', () => assert.match(html, /id="count"/)],
  ['存在 +1 按钮', () => assert.match(html, /id="inc"/)],
  ['存在 -1 按钮', () => assert.match(html, /id="dec"/)],
  ['存在重置按钮', () => assert.match(html, /id="reset"/)],
  ['使用 localStorage 持久化', () => assert.match(js, /localStorage/)],
];

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log('  \\x1b[32m✔\\x1b[0m ' + name);
  } catch (e) {
    failed++;
    console.log('  \\x1b[31m✘\\x1b[0m ' + name);
  }
}
console.log(failed ? \`\\n\${failed} 项失败\` : '\\n全部通过 ✅');
process.exit(failed ? 1 : 0);
`;

const PRD = `# 像素计数器 PRD

## 背景
老板需要一个可以快速演示的小工具。

## 功能
1. 显示当前计数（大号像素字体）
2. +1 / -1 按钮
3. 重置按钮
4. 刷新页面后计数保留

## 验收标准
- 点击 +1 两次显示 2
- 点击重置显示 0
- 负数显示为红色
`;

function devScript(): Step[] {
  return [
    { text: '先看看工作区现在有什么。', calls: [{ name: 'run_command', args: { command: 'ls -la && git log --oneline -3 2>/dev/null || echo "(还没有提交)"' } }] },
    { text: '开始写页面结构和样式。', calls: [{ name: 'write_file', args: { path: 'app/index.html', content: COUNTER_HTML } }] },
    { text: '接着写交互逻辑。', calls: [{ name: 'write_file', args: { path: 'app/app.js', content: COUNTER_JS } }] },
    { text: '做一下语法检查。', calls: [{ name: 'run_command', args: { command: 'node --check app/app.js && echo "语法检查通过 ✔" && wc -l app/*' } }] },
    { text: '清理一下旧的构建缓存目录。', calls: [{ name: 'run_command', args: { command: 'rm -rf app/.cache && echo 已清理' } }] },
    { text: '在浏览器里打开看看效果。', calls: [{ name: 'browser_open', args: { url: 'app/index.html' } }] },
    { text: '点一下 +1 验证交互。', calls: [{ name: 'browser_click', args: { text: '+1' } }] },
    { text: '再点一下，应该显示 2。', calls: [{ name: 'browser_click', args: { text: '+1' } }] },
    { text: '功能正常，提交代码。', calls: [{ name: 'run_command', args: { command: 'git add -A && git commit -q -m "feat: 像素计数器页面" && git log --oneline -3' } }] },
    { text: '提交评审。', calls: [{ name: 'submit_for_review', args: { summary: '完成像素计数器：app/index.html + app/app.js。支持 +1/-1/重置与 localStorage 持久化；已用 node --check 校验语法，并在浏览器中实际点击验证（点击两次 +1 显示 2）。已 git commit。' } }] },
  ];
}

function qaScript(): Step[] {
  return [
    { text: '先读一下研发的实现。', calls: [{ name: 'read_file', args: { path: 'app/app.js' } }] },
    { text: '写一个冒烟测试脚本。', calls: [{ name: 'write_file', args: { path: 'tests/counter.test.mjs', content: COUNTER_TEST } }] },
    { text: '跑测试。', calls: [{ name: 'run_command', args: { command: 'node tests/counter.test.mjs' } }] },
    { text: '再做页面手工测试。', calls: [{ name: 'browser_open', args: { url: 'app/index.html' } }] },
    { text: '点击 -1，期望显示负数红色。', calls: [{ name: 'browser_click', args: { text: '-1' } }] },
    { text: '点击重置。', calls: [{ name: 'browser_click', args: { text: '重置' } }] },
    {
      text: '写测试报告。',
      calls: [{ name: 'write_file', args: { path: 'docs/test-reports/counter.md', content: '# 计数器测试报告\n\n| 用例 | 结果 |\n|---|---|\n| 页面结构 | ✅ |\n| +1 / -1 | ✅ |\n| 负数红色 | ✅ |\n| 重置 | ✅ |\n| 持久化 | ✅ |\n\n结论：通过。\n' } }],
    },
    { text: '提交测试产出。', calls: [{ name: 'run_command', args: { command: 'git add -A && git commit -q -m "test: 计数器冒烟测试与报告" && git log --oneline -3' } }] },
    { text: '提交评审。', calls: [{ name: 'submit_for_review', args: { summary: '测试通过：tests/counter.test.mjs 自动化 5 项全过；浏览器手工验证 -1（红色负数）、重置正常。报告见 docs/test-reports/counter.md。' } }] },
  ];
}

function pmScript(): Step[] {
  return [
    { text: '整理需求文档。', calls: [{ name: 'write_file', args: { path: 'docs/prd.md', content: PRD } }] },
    { text: '提交评审。', calls: [{ name: 'submit_for_review', args: { summary: '需求文档见 docs/prd.md，含功能清单与验收标准。' } }] },
  ];
}

function managerStep(prompt: string, step: number, lastTool: string): Step {
  const goal = /(G-[a-z0-9]+)/.exec(prompt)?.[1];
  const task = /任务 (T-[a-z0-9]+)/.exec(prompt)?.[1];
  const approval = /审批 id：(A-[a-z0-9]+)/.exec(prompt)?.[1];

  if (approval) {
    return step === 0
      ? { text: `看了一下，这是工作区内的缓存清理，风险可控，批准。`, calls: [{ name: 'decide_approval', args: { approval_id: approval, decision: 'approve', comment: '工作区内清理，同意' } }] }
      : { text: '已处理。' };
  }
  if (prompt.includes('请规划')) {
    const created = /已创建 (T-[a-z0-9]+)/.exec(lastTool)?.[1];
    const steps: Step[] = [
      { text: '先了解工作区现状。', calls: [{ name: 'list_files', args: { path: '.' } }] },
      {
        text: '拆成研发和测试两个子任务，测试依赖研发。',
        calls: [{ name: 'create_subtask', args: { goal_id: goal, role: 'dev', title: '实现像素计数器页面', description: '在 app/ 下实现静态页面：计数显示、+1/-1、重置、localStorage 持久化。验收：浏览器中点击两次 +1 显示 2。' } }],
      },
      {
        text: '派发测试任务。',
        calls: [{ name: 'create_subtask', args: { goal_id: goal, role: 'qa', title: '测试像素计数器', description: '编写自动化冒烟测试，并在浏览器中手工验证全部按钮，输出测试报告到 docs/test-reports/。', depends_on: created ? [created] : [] } }],
      },
      { text: '任务已派发完毕，等大家的产出。' },
    ];
    return steps[Math.min(step, steps.length - 1)];
  }
  if (prompt.includes('请评审')) {
    return step === 0
      ? { text: '我亲自看一下提交记录和改动。', calls: [{ name: 'run_command', args: { command: 'git log --oneline -5 && git show --stat HEAD | head -20' } }] }
      : step === 1
        ? { text: '产出符合验收标准，通过。', calls: [{ name: 'approve_task', args: { task_id: task, comment: '验证充分，通过' } }] }
        : { text: '已评审。' };
  }
  if (prompt.includes('所有子任务均已完成')) {
    return step === 0
      ? {
          text: '所有子任务完成，整理交付总结。',
          calls: [{ name: 'finalize_goal', args: { goal_id: goal, summary: '已交付像素计数器：\n- 页面：workspace/app/index.html（直接用浏览器打开）\n- 逻辑：app/app.js（+1/-1/重置/持久化）\n- 测试：tests/counter.test.mjs（node 运行，5 项通过）\n- 报告：docs/test-reports/counter.md\n遗留问题：无。' } }],
        }
      : { text: '已提交老板验收。' };
  }
  if (prompt.includes('受阻')) {
    return step === 0 ? { text: '给出指导，让员工继续。', calls: [{ name: 'request_changes', args: { task_id: task, feedback: '请按任务描述继续完成并提交。' } }] } : { text: '已处理。' };
  }
  return { text: '收到，老板。我会按这个方向安排工作。' };
}

export class MockLLM implements LLM {
  async chat(messages: ChatMessage[], _tools: unknown, cb: StreamCallbacks, ctx: LLMContext, signal?: AbortSignal): Promise<LLMResult> {
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    const step = messages.filter((m) => m.role === 'assistant').length;
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
    const isTask = /你被分配了任务/.test(firstUser);

    let s: Step;
    if (ctx.roleId === 'manager') s = managerStep(firstUser, step, lastTool);
    else if (!isTask) s = { text: '收到老板指示，我记下了。' };
    else {
      const script = ctx.roleId === 'dev' ? devScript() : ctx.roleId === 'qa' ? qaScript() : pmScript();
      s = script[Math.min(step, script.length - 1)];
    }

    await sleep(400);
    for (let i = 0; i < s.text.length; i += 2) {
      if (signal?.aborted) break;
      cb.onText(s.text.slice(i, i + 2));
      await sleep(30);
    }

    const calls: ToolCall[] = (s.calls ?? []).map((c, i) => ({ id: `call_${Date.now()}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    for (const c of calls) {
      const full = c.function.arguments;
      // 模拟参数流式到达：写文件时屏幕上能看到代码一点点出现
      const chunk = c.function.name === 'write_file' ? 12 : full.length;
      for (let i = chunk; i < full.length + chunk; i += chunk) {
        cb.onToolArgs(c.function.name, full.slice(0, i));
        if (c.function.name === 'write_file') await sleep(16);
      }
    }
    await sleep(200);
    const message: LLMResult['message'] = { role: 'assistant', content: s.text };
    if (calls.length) message.tool_calls = calls;
    const approxIn = JSON.stringify(messages).length / 3;
    return { message, usage: { input: Math.round(approxIn), output: Math.round((s.text.length + JSON.stringify(calls).length) / 3) } };
  }
}
