import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { ArtifactFile, Budget, Priority, ServerMsg, Settings, Snapshot } from '@af/shared';
import { bus } from './bus.js';
import { company } from './company.js';
import { config } from './config.js';
import { db } from './db.js';
import { factory } from './factory.js';
import { MockLLM } from './llm/mock.js';
import { OpenAICompatLLM } from './llm/openai.js';
import type { LLM } from './llm/types.js';
import { setLLM } from './llm/index.js';
import { store } from './store.js';
import { usage } from './usage.js';
import { settings } from './settings.js';
import { notifier } from './notify.js';
import { imRegistry } from './im/index.js';
import { handle as handleChat } from './im/commands.js';
import { browserFrames } from './tools/browser.js';
import { screenSnapshot } from './tools/screens.js';
import { terminalBuffers } from './tools/terminal.js';
import * as wf from './workflow.js';

function initWorkspace() {
  fs.mkdirSync(config.workspace, { recursive: true });
  const kb = path.join(config.workspace, 'KNOWLEDGE.md');
  if (!fs.existsSync(kb)) {
    fs.writeFileSync(kb, '# 公司知识库\n\n在这里记录项目规范、技术选型和重要决策，所有员工开工前都会阅读。\n');
  }
}

async function createLLM(): Promise<LLM> {
  if (config.llm.provider === 'mock') {
    bus.log('warn', '未配置 DEEPSEEK_API_KEY，进入演示模式：剧本驱动，但终端、浏览器、文件操作全部真实执行');
    return new MockLLM();
  }
  const llm = new OpenAICompatLLM();
  try {
    const models = await llm.listModels();
    bus.log('info', `模型服务可用模型：${models.join(', ')}；当前使用 ${config.llm.model}`);
    if (!models.includes(config.llm.model)) bus.log('warn', `LLM_MODEL=${config.llm.model} 不在可用列表中，请检查 .env`);
  } catch (e: any) {
    bus.log('warn', `无法获取模型列表：${e?.message ?? e}`);
  }
  return llm;
}

const PREVIEW_BASE = `/preview/${randomBytes(18).toString('base64url')}/`;

function snapshot(): Snapshot {
  return {
    profile: company.profile,
    profiles: company.list(),
    llm: { provider: config.llm.provider, model: config.llm.provider === 'mock' ? '演示模式' : config.llm.model },
    agents: [...store.agents.values()],
    tasks: [...store.tasks.values()],
    approvals: [...store.approvals.values()].filter((a) => a.status === 'pending' || Date.now() - a.createdAt < 86400000),
    logs: bus.logs.slice(-500),
    terminals: terminalBuffers(),
    frames: browserFrames(),
    ...screenSnapshot(),
    meetings: [...store.meetings.values()].slice(-10),
    globalPaused: store.globalPaused,
    usage: usage.stats(),
    settings: settings.get(),
    im: imRegistry.status(),
    previewBase: PREVIEW_BASE,
  };
}

async function main() {
  initWorkspace();
  const pgOk = await db.init();
  if (pgOk) bus.log('success', 'PostgreSQL 数据库已连接并完成表结构初始化');
  await store.load();
  await usage.load();
  await settings.load();
  notifier.start();
  store.onDecided = wf.onApprovalDecided;
  const llm = await createLLM();
  setLLM(llm);

  const app = Fastify({ bodyLimit: 1024 * 1024 });
  await app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    if (!config.accessToken || !req.url.startsWith('/api') && !req.url.startsWith('/ws')) return;
    const token = (req.headers['x-token'] as string) || new URL(req.url, 'http://x').searchParams.get('token');
    if (token !== config.accessToken) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/ws', { websocket: true }, (socket) => {
    const send = (m: ServerMsg) => socket.readyState === 1 && socket.send(JSON.stringify(m));
    send({ t: 'snapshot', d: snapshot() });
    const off = bus.on(send);
    socket.on('close', off);
  });

  const ok = { ok: true };
  const fail = (reply: any, msg: string) => reply.code(400).send({ error: msg });

  app.get('/api/snapshot', async () => snapshot());

  app.post<{ Body: { title: string; description?: string; priority?: Priority } }>('/api/goals', async (req, reply) => {
    const { title, description = '', priority = 'P2' } = req.body ?? ({} as any);
    if (!title?.trim()) return fail(reply, '标题不能为空');
    return wf.createGoal(title.trim(), description, priority);
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/tasks/:id/cancel', async (req, reply) => {
    const t = store.tasks.get(req.params.id);
    if (!t) return fail(reply, '任务不存在');
    if (t.kind === 'goal') for (const k of store.children(t.id)) if (!['done', 'cancelled'].includes(k.status)) wf.cancelTask(k, '老板取消了目标', 'human');
    wf.cancelTask(t, req.body?.reason || '老板取消', 'human');
    return ok;
  });

  app.post<{ Params: { id: string }; Body: { priority: Priority } }>('/api/tasks/:id/priority', async (req, reply) => {
    const t = store.updateTask(req.params.id, { priority: req.body.priority });
    if (!t) return fail(reply, '任务不存在');
    bus.log('info', `老板把 ${t.id} 调整为 ${t.priority}`, null, t.id);
    return ok;
  });

  app.post<{ Params: { id: string }; Body: { approve: boolean; comment?: string } }>('/api/approvals/:id', async (req, reply) => {
    const a = store.decideApproval(req.params.id, !!req.body.approve, 'human', req.body.comment ?? '');
    if (!a) return fail(reply, '审批不存在或已处理');
    return ok;
  });

  app.post<{ Params: { id: string }; Body: { paused: boolean } }>('/api/agents/:id/pause', async (req, reply) => {
    if (!store.agents.has(req.params.id)) return fail(reply, '员工不存在');
    factory.pause(req.params.id, !!req.body.paused);
    return ok;
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>('/api/agents/:id/message', async (req, reply) => {
    if (!store.agents.has(req.params.id)) return fail(reply, '员工不存在');
    if (!req.body.text?.trim()) return fail(reply, '内容不能为空');
    factory.message(req.params.id, req.body.text.trim());
    return ok;
  });

  app.post<{ Body: { paused: boolean } }>('/api/pause', async (req) => {
    factory.pauseAll(!!req.body.paused);
    return ok;
  });

  app.post<{ Body: Partial<Settings> }>('/api/settings', async (req, reply) => {
    try {
      return settings.update(req.body ?? {});
    } catch (e: any) {
      return fail(reply, e.message);
    }
  });

  // 本地调试聊天指令（不连钉钉）：IM_SIMULATE=1 时开启
  if (process.env.IM_SIMULATE === '1') {
    app.post<{ Body: { text: string; userId?: string; admin?: boolean } }>('/api/im/simulate', async (req) => {
      const id = req.body.userId ?? 'sim-user';
      return handleChat(req.body.text ?? '', { id, name: '模拟用户', admin: req.body.admin ?? settings.get().im.dingtalkAdmins.includes(id), platform: '模拟' });
    });
  }

  app.post('/api/settings/test-notify', async (_req, reply) => {
    try {
      await notifier.test();
      return ok;
    } catch (e: any) {
      return fail(reply, `推送失败：${e?.message ?? e}`);
    }
  });

  // 批量审批：只允许操作审批（tool），请示和验收需要逐条看
  app.post<{ Body: { ids: string[]; approve: boolean; comment?: string } }>('/api/approvals/batch', async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let n = 0;
    for (const id of ids) {
      const a = store.approvals.get(id);
      if (!a || a.kind !== 'tool' || a.status !== 'pending' || a.approver !== 'human') continue;
      if (store.decideApproval(id, !!req.body.approve, 'human', req.body.comment ?? '')) n++;
    }
    if (!n) return fail(reply, '没有可批量处理的事项');
    return { ok: true, count: n };
  });

  app.post<{ Body: Partial<Budget> }>('/api/budget', async (req) => {
    usage.setBudget(req.body ?? {});
    return usage.stats().budget;
  });

  // 交付页：目标及其子任务产出的文件（过滤 .tmp 等临时文件）
  app.get<{ Params: { id: string } }>('/api/goals/:id/files', async (req, reply) => {
    const goal = store.tasks.get(req.params.id);
    if (!goal || goal.kind !== 'goal') return fail(reply, '目标不存在');
    const files = new Map<string, ArtifactFile>();
    for (const t of [goal, ...store.children(goal.id)]) {
      for (const p of t.artifacts) {
        if (/^(\.tmp|node_modules|\.git)(\/|-|$)/.test(p)) continue;
        const f = files.get(p) ?? { path: p, exists: false, size: 0, mtime: 0, taskIds: [] };
        if (t.kind === 'task') f.taskIds.push(t.id);
        files.set(p, f);
      }
    }
    for (const f of files.values()) {
      try {
        const st = fs.statSync(path.join(config.workspace, f.path));
        Object.assign(f, { exists: st.isFile(), size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
    return [...files.values()].sort((a, b) => Number(b.exists) - Number(a.exists) || b.mtime - a.mtime || a.path.localeCompare(b.path));
  });

  // 交付页：老板对某个产出文件发起「局部微调」，直接唤醒原执行员工快速修改
  app.post<{ Params: { id: string }; Body: { instruction: string; path?: string } }>('/api/goals/:id/revise', async (req, reply) => {
    const goal = store.tasks.get(req.params.id);
    if (!goal || goal.kind !== 'goal') return fail(reply, '目标不存在');
    const instruction = req.body?.instruction?.trim();
    if (!instruction) return fail(reply, '请填写微调修改意见');
    wf.reviseGoalArtifact(goal, instruction, req.body?.path);
    return ok;
  });

  // 交付页：一键打包下载目标全部产出文件（ZIP）
  app.get<{ Params: { id: string } }>(`${PREVIEW_BASE}__archive/:id.zip`, async (req, reply) => {
    const goal = store.tasks.get(req.params.id);
    if (!goal || goal.kind !== 'goal') return reply.code(404).send('Not Found');
    const paths = [...new Set([goal, ...store.children(goal.id)].flatMap((t) => t.artifacts))].filter((p) => {
      if (/^(\.tmp|node_modules|\.git)(\/|-|$)/.test(p)) return false;
      try {
        return fs.statSync(path.join(config.workspace, p)).isFile();
      } catch {
        return false;
      }
    });
    if (!paths.length) return reply.code(404).send('No artifact files');
    const buf = execFileSync('zip', ['-q', '-', ...paths], { cwd: config.workspace, maxBuffer: 50 * 1024 * 1024 });
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${goal.id}-artifacts.zip"`)
      .send(buf);
  });

  // 工作区文件只读直出（交付页预览/下载）。地址里带随机密钥，只通过已鉴权的 WebSocket 下发：
  // 预览的网页、图片、下载链接都带不了请求头，而 AI 生成的网页也不该拿到访问口令。.git 等隐藏文件不对外
  await app.register(fastifyStatic, { root: config.workspace, prefix: PREVIEW_BASE, decorateReply: false, index: false, dotfiles: 'deny' });

  app.post<{ Body: { id: string } }>('/api/profile', async (req, reply) => {
    try {
      await factory.switchProfile(req.body.id);
      bus.emit({ t: 'snapshot', d: snapshot() });
      return ok;
    } catch (e: any) {
      return fail(reply, e.message);
    }
  });

  // 员工模型等公司素材：company/models/ → /models/
  const modelsDir = path.join(config.profilesDir, '..', 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  await app.register(fastifyStatic, { root: modelsDir, prefix: '/models/', decorateReply: false });

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') || req.url.startsWith('/preview/') ? reply.code(404).send() : reply.sendFile('index.html')));
  }

  await app.listen({ port: config.port, host: config.host });
  bus.log('info', `服务已启动 http://localhost:${config.port}`);
  // 端口占用时上面会直接失败，不会出现员工已开工但服务没起来的情况
  factory.init(llm, config.defaultProfile);
  settings.startTimeouts();
  imRegistry.startAll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
