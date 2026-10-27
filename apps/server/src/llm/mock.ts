import type { ChatMessage, CompleteRequest, LLM, LLMContext, LLMResult, StreamCallbacks, ToolCall } from './types.js';

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

const XHS = `# 小红书笔记：复古像素计数器

**标题：** 打工人续命小工具🧮 这个像素风计数器也太可爱了吧！

---

姐妹们！最近挖到一个超治愈的小工具✨
复古像素风🎮 点一下 +1，数字会跳一下，强迫症狂喜！

📌 **能干嘛：**
- 喝水打卡💧 每喝一杯点一下
- 背单词计数📖 今天背了多少一目了然
- 番茄钟计次🍅 专注一轮 +1

📌 **贴心细节：**
- 刷新页面数字不会丢（自动保存）
- 负数会变红色🔴 一眼就能看出来
- 打开网页就能用，不用下载 App

用了一周，喝水量从 3 杯涨到 7 杯😂 真的有被激励到！

#效率工具 #打工人日常 #喝水打卡 #像素风 #自律生活 #小工具推荐 #治愈系
`;

const RESEARCH = `# 小红书推广调研

## 目标用户
- 20-30 岁上班族、学生，关注效率与自律

## 竞品笔记特点（参考同类工具爆款）
1. 标题带“打工人/续命/治愈”等情绪词
2. 正文用 emoji 分段，强调具体使用场景
3. 结尾 5~10 个话题标签

## 建议
- 主打「喝水打卡」场景，搭配前后对比数据
- 配图用像素风截图 + 手机实拍
`;

function devScript(): Step[] {
  return [
    { text: '先看看工作区现在有什么。', calls: [{ name: 'run_command', args: { command: 'ls -la && git log --oneline -3 2>/dev/null || echo "(还没有提交)"' } }] },
    { text: '开始写页面结构和样式。', calls: [{ name: 'write_file', args: { path: 'app/index.html', content: COUNTER_HTML } }] },
    { text: '移动端适配要不要做，我去问问经理。', calls: [{ name: 'ask_manager', args: { question: '计数器页面需要专门做手机端适配吗？还是先保证桌面端？' } }] },
    { text: '经理说先保证桌面端，接着写交互逻辑。', calls: [{ name: 'write_file', args: { path: 'app/app.js', content: COUNTER_JS } }] },
    { text: '做一下语法检查。', calls: [{ name: 'run_command', args: { command: 'node --check app/app.js && echo "语法检查通过 ✔" && wc -l app/*' } }] },
    { text: '清理一下旧的构建缓存目录。', calls: [{ name: 'run_command', args: { command: 'rm -rf app/.cache && echo 已清理' } }] },
    { text: '在浏览器里打开看看效果。', calls: [{ name: 'browser_open', args: { url: 'app/index.html' } }] },
    { text: '点一下 +1 验证交互。', calls: [{ name: 'browser_click', args: { text: '+1' } }] },
    { text: '再点一下。', calls: [{ name: 'browser_click', args: { text: '+1' } }] },
    { text: '功能正常，提交代码。', calls: [{ name: 'run_command', args: { command: 'git add -A && git commit -q -m "feat: 像素计数器页面" ; git log --oneline -3' } }] },
    {
      text: '对照验收标准自查后提交评审。',
      calls: [
        {
          name: 'submit_for_review',
          args: {
            summary: '完成像素计数器：app/index.html + app/app.js，支持 +1/-1/重置与 localStorage 持久化，已 git commit。',
            self_check: '✅ 计数显示与加减按钮：浏览器中点击两次 +1 计数增加 2\n✅ 重置按钮：已实现\n✅ 持久化：使用 localStorage\n✅ 语法检查：node --check 通过',
          },
        },
      ],
    },
  ];
}

function qaScript(): Step[] {
  return [
    { text: '先读一下研发的实现。', calls: [{ name: 'read_file', args: { path: 'app/app.js' } }] },
    { text: '持久化的细节我去问问阿码。', calls: [{ name: 'ask_colleague', args: { agent_id: 'dev1', question: '计数器持久化用的 localStorage key 是什么？刷新后应该保持原值对吧？' } }] },
    { text: '写一个冒烟测试脚本。', calls: [{ name: 'write_file', args: { path: 'tests/counter.test.mjs', content: COUNTER_TEST } }] },
    { text: '跑测试。', calls: [{ name: 'run_command', args: { command: 'node tests/counter.test.mjs' } }] },
    { text: '再做页面手工测试。', calls: [{ name: 'browser_open', args: { url: 'app/index.html' } }] },
    { text: '点击重置。', calls: [{ name: 'browser_click', args: { text: '重置' } }] },
    { text: '点击 -1，期望显示红色负数。', calls: [{ name: 'browser_click', args: { text: '-1' } }] },
    {
      text: '写测试报告。',
      calls: [{ name: 'write_file', args: { path: 'docs/test-reports/counter.md', content: '# 计数器测试报告\n\n| 用例 | 结果 |\n|---|---|\n| 页面结构 | ✅ |\n| +1 / -1 | ✅ |\n| 负数红色 | ✅ |\n| 重置 | ✅ |\n| 持久化 | ✅ |\n\n结论：通过。\n' } }],
    },
    { text: '提交测试产出。', calls: [{ name: 'run_command', args: { command: 'git add -A && git commit -q -m "test: 计数器冒烟测试与报告" ; git log --oneline -3' } }] },
    {
      text: '提交评审。',
      calls: [
        {
          name: 'submit_for_review',
          args: { summary: '测试通过：自动化 5 项全过，浏览器手工验证重置与负数显示正常。报告见 docs/test-reports/counter.md。', self_check: '✅ 自动化测试：5/5 通过\n✅ 浏览器手工测试：全部按钮正常\n✅ 测试报告：已输出' },
        },
      ],
    },
  ];
}

function pmScript(): Step[] {
  return [
    { text: '整理需求文档。', calls: [{ name: 'write_file', args: { path: 'docs/prd.md', content: PRD } }] },
    { text: '提交评审。', calls: [{ name: 'submit_for_review', args: { summary: '需求文档见 docs/prd.md，含功能清单与验收标准。', self_check: '✅ 功能清单\n✅ 验收标准' } }] },
  ];
}

function contentScript(): Step[] {
  return [
    { text: '先看看产品和调研资料。', calls: [{ name: 'list_files', args: { path: '.' } }] },
    { text: '调研结论我去跟阿数确认一下重点。', calls: [{ name: 'ask_colleague', args: { agent_id: 'ops2', question: '小红书这篇主打哪个使用场景转化最好？标签用哪些？' } }] },
    { text: '按小红书调性写成稿。', calls: [{ name: 'write_file', args: { path: 'marketing/xiaohongshu-counter.md', content: XHS } }] },
    {
      text: '自查后提交。',
      calls: [
        {
          name: 'submit_for_review',
          args: {
            summary: '小红书笔记成稿：marketing/xiaohongshu-counter.md，主打喝水打卡场景。',
            self_check: '✅ 吸睛标题\n✅ emoji 分段、真实场景\n✅ 7 个话题标签\n✅ 未夸大或虚构功能',
          },
        },
      ],
    },
  ];
}

function growthScript(): Step[] {
  return [
    { text: '整理调研结论。', calls: [{ name: 'write_file', args: { path: 'marketing/research.md', content: RESEARCH } }] },
    { text: '提交。', calls: [{ name: 'submit_for_review', args: { summary: '调研见 marketing/research.md，建议主打喝水打卡场景。', self_check: '✅ 目标用户\n✅ 竞品笔记特点\n✅ 可执行建议' } }] },
  ];
}

const isContentGoal = (s: string) => /文案|小红书|公众号|推广|营销|笔记|种草|宣传/.test(s);

function managerStep(prompt: string, step: number, toolOutputs: string[]): Step {
  const goal = /(G-[a-z0-9]+)/.exec(prompt)?.[1];
  const task = /任务 (T-[a-z0-9]+)/.exec(prompt)?.[1];
  const approval = /审批 id：(A-[a-z0-9]+)/.exec(prompt)?.[1];
  const created = toolOutputs.flatMap((o) => [...o.matchAll(/已创建 (T-[a-z0-9]+)/g)].map((m) => m[1]));
  const lastTool = toolOutputs[toolOutputs.length - 1] ?? '';

  if (approval) {
    return step === 0
      ? { text: '工作区内的缓存清理，风险可控，批准。', calls: [{ name: 'decide_approval', args: { approval_id: approval, decision: 'approve', comment: '工作区内清理，同意' } }] }
      : { text: '已处理。' };
  }
  if (prompt.includes('规划目标的标准步骤')) {
    if (isContentGoal(prompt)) {
      const xhsTask = {
        goal_id: goal,
        title: '撰写小红书推广笔记',
        description: '根据调研结论写一篇小红书笔记成稿，保存到 marketing/xiaohongshu-counter.md。',
        acceptance: '1. 有吸睛标题\n2. emoji 分段、有真实使用场景\n3. 5~10 个话题标签\n4. 不夸大、不虚构功能',
        depends_on: created.slice(0, 1),
      };
      const steps: Step[] = [
        { text: '这是内容推广类目标，交付物是文案，归内容运营；先让增长运营做调研。先开个短会对齐。', calls: [{ name: 'call_meeting', args: { topic: '小红书推广启动会', agenda: '确定目标用户、主打场景和笔记风格，明确调研与写作分工', participants: ['ops1', 'ops2'] } }] },
        {
          text: '派发调研任务给增长运营。',
          calls: [{ name: 'create_subtask', args: { goal_id: goal, role: 'growth', title: '小红书竞品笔记与目标用户调研', description: '调研同类工具的小红书爆款笔记，输出 marketing/research.md。', acceptance: '1. 目标用户画像\n2. 至少 3 条竞品笔记特点\n3. 可执行的主打场景建议' } }],
        },
        // 演示派单校验：先误派给研发，会被拦截
        { text: '写文案的活……先派给阿码试试。', calls: [{ name: 'create_subtask', args: { ...xhsTask, role: 'dev' } }] },
        { text: '被拦截了，确实应该归内容运营，改派。', calls: [{ name: 'create_subtask', args: { ...xhsTask, role: 'content', depends_on: created.slice(0, 1) } }] },
        { text: '派发完毕。' },
      ];
      return steps[Math.min(step, steps.length - 1)];
    }
    const steps: Step[] = [
      { text: '这是开发类目标，研发和测试都要参与，先开个短会对齐。', calls: [{ name: 'call_meeting', args: { topic: '计数器开发启动会', agenda: '对齐功能范围、技术方案和测试重点', participants: ['dev1', 'qa1'] } }] },
      {
        text: '派研发任务。',
        calls: [{ name: 'create_subtask', args: { goal_id: goal, role: 'dev', title: '实现像素计数器页面', description: '在 app/ 下实现静态页面：计数显示、+1/-1、重置、localStorage 持久化。', acceptance: '1. 浏览器中点击两次 +1 显示 2\n2. 重置后显示 0\n3. 刷新后数值保留\n4. 代码已 git commit' } }],
      },
      {
        text: '派测试任务，依赖研发。',
        calls: [{ name: 'create_subtask', args: { goal_id: goal, role: 'qa', title: '测试像素计数器', description: '编写自动化冒烟测试，并在浏览器中手工验证全部按钮，报告输出到 docs/test-reports/。', acceptance: '1. 自动化测试覆盖页面结构与持久化\n2. 浏览器验证所有按钮\n3. 输出测试报告', depends_on: created.slice(0, 1) } }],
      },
      { text: '派发完毕，等大家的产出。' },
    ];
    return steps[Math.min(step, steps.length - 1)];
  }
  if (prompt.includes('处理退单')) {
    const role = /建议岗位：(\w+)/.exec(prompt)?.[1] ?? 'content';
    return step === 0 ? { text: '退单理由成立，改派。', calls: [{ name: 'reassign_task', args: { task_id: task, role, note: '按岗位职责改派' } }] } : { text: '已处理。' };
  }
  if (prompt.includes('请评审')) {
    return step === 0
      ? { text: '我对照验收标准看一下提交记录和产出。', calls: [{ name: 'run_command', args: { command: 'git log --oneline -5 && git status --short | head -20' } }] }
      : step === 1
        ? { text: '验收标准逐条满足，通过。', calls: [{ name: 'approve_task', args: { task_id: task, comment: '对照验收标准检查通过' } }] }
        : { text: '已评审。' };
  }
  if (prompt.includes('所有子任务均已完成')) {
    const summary = isContentGoal(prompt)
      ? '已交付小红书推广笔记：\n- 调研：marketing/research.md\n- 成稿：marketing/xiaohongshu-counter.md（可直接发布）\n- 会议纪要：docs/meetings/\n遗留问题：配图需要实拍。'
      : '已交付像素计数器：\n- 页面：app/index.html（直接用浏览器打开）\n- 逻辑：app/app.js\n- 测试：tests/counter.test.mjs，报告 docs/test-reports/counter.md\n遗留问题：无。';
    return step === 0 ? { text: '所有子任务完成，整理交付总结。', calls: [{ name: 'finalize_goal', args: { goal_id: goal, summary } }] } : { text: '已提交老板验收。' };
  }
  if (prompt.includes('受阻')) {
    return step === 0 ? { text: '给出指导，让员工继续。', calls: [{ name: 'request_changes', args: { task_id: task, feedback: '请按任务描述和验收标准继续完成并提交。' } }] } : { text: '已处理。' };
  }
  void lastTool;
  return { text: '收到，老板。我会按这个方向安排工作。' };
}

// ---------------- 单轮补全（派单校验 / 会议 / 答疑） ----------------

const ROLE_HINTS: [RegExp, string][] = [
  [/调研|竞品|增长|投放|数据分析/, 'growth'],
  [/文案|小红书|公众号|推文|笔记|种草|slogan|宣传语/, 'content'],
  [/测试|验证/, 'qa'],
  [/PRD|需求文档/, 'pm'],
  [/代码|页面|实现|开发|脚本/, 'dev'],
];

function mockRouteCheck(user: string) {
  const sub = /子任务：(.*)\n描述：(.*)/.exec(user);
  const assigned = /拟派给角色：(\w+)/.exec(user)?.[1];
  const text = sub ? sub[1] : user;
  const expect = ROLE_HINTS.find(([re]) => re.test(text))?.[1];
  if (expect && assigned && expect !== assigned) return JSON.stringify({ ok: false, suggest: expect, reason: `这是${expect === 'content' ? '文案创作' : '该岗位'}类产出，不属于 ${assigned} 的职责` });
  return '{"ok": true}';
}

const MEETING_LINES: Record<string, string[]> = {
  manager: ['好，今天把方向和分工对齐，大家从自己岗位说说负责哪部分、有什么顾虑。'],
  pm: ['我补充一下验收标准，重点是核心交互和数据不丢。'],
  dev: ['技术上用纯静态页面就够，localStorage 做持久化，半小时内能出第一版。', '我做完会先自测，再交给测试。'],
  qa: ['我这边会写自动化冒烟测试，再用浏览器把按钮全点一遍，重点测刷新后数据是否保留。'],
  content: ['文案我来写，建议走小红书爆款结构：情绪化标题 + 场景化正文 + 话题标签。需要先拿到调研结论。'],
  growth: ['我先调研同类工具的爆款笔记和目标用户，今天给出主打场景建议，供小文写稿。'],
};

function mockComplete(req: CompleteRequest, ctx: LLMContext) {
  const role = ctx.roleId;
  switch (req.kind) {
    case 'route_check':
      return mockRouteCheck(req.user);
    case 'meeting_open': {
      const topic = /议题：(.*)/.exec(req.user)?.[1] ?? '';
      return `大家好，今天对齐「${topic}」。${MEETING_LINES.manager[0]}`;
    }
    case 'meeting_speak': {
      const lines = MEETING_LINES[role] ?? ['我这边没问题，按分工推进。'];
      const n = (req.user.match(/\n/g) ?? []).length;
      return lines[n % lines.length];
    }
    case 'meeting_summary':
      return '**结论**：按讨论的方向推进。\n**分工**：各岗位按发言认领的部分执行，交付物按验收标准提交。\n**风险**：注意前后依赖，先完成的同事及时同步产出。';
    case 'consult':
      if (role === 'manager') return '先保证核心功能和桌面端体验，手机端适配不在本次范围内，做完记得自测再提交。';
      if (role === 'dev') return 'key 是 pixel-counter，刷新后会保持原值，你可以重点测一下负数和重置。';
      if (role === 'growth') return '主打喝水打卡场景转化最好，标签建议用 #效率工具 #打工人日常 #喝水打卡。';
      return '收到，我这边按这个来。';
  }
}

export class MockLLM implements LLM {
  async complete(req: CompleteRequest, ctx: LLMContext) {
    await sleep(600 + Math.random() * 600);
    const text = mockComplete(req, ctx);
    return { text, usage: { input: Math.round((req.system.length + req.user.length) / 3), output: Math.round(text.length / 2) } };
  }

  async chat(messages: ChatMessage[], _tools: unknown, cb: StreamCallbacks, ctx: LLMContext, signal?: AbortSignal): Promise<LLMResult> {
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    const step = messages.filter((m) => m.role === 'assistant').length;
    const toolOutputs = messages.filter((m) => m.role === 'tool').map((m) => m.content);
    const isTask = /你被分配了任务/.test(firstUser);

    let s: Step;
    if (ctx.roleId === 'manager') s = managerStep(firstUser, step, toolOutputs);
    else if (!isTask) s = { text: '收到老板指示，我记下了。' };
    else {
      const scripts: Record<string, () => Step[]> = { dev: devScript, qa: qaScript, pm: pmScript, content: contentScript, growth: growthScript };
      const script = (scripts[ctx.roleId] ?? pmScript)();
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
