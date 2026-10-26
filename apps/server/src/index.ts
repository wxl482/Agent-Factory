import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { Priority, ServerMsg, Snapshot } from '@af/shared';
import { bus } from './bus.js';
import { company } from './company.js';
import { config } from './config.js';
import { factory } from './factory.js';
import { MockLLM } from './llm/mock.js';
import { OpenAICompatLLM } from './llm/openai.js';
import type { LLM } from './llm/types.js';
import { store } from './store.js';
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
  if (!fs.existsSync(path.join(config.workspace, '.git'))) {
    const env = { ...process.env, GIT_AUTHOR_NAME: 'factory', GIT_AUTHOR_EMAIL: 'factory@agent-factory.local', GIT_COMMITTER_NAME: 'factory', GIT_COMMITTER_EMAIL: 'factory@agent-factory.local' };
    execSync('git init -q && git add -A && git commit -q -m "chore: 初始化工作区"', { cwd: config.workspace, env });
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
    globalPaused: store.globalPaused,
  };
}

async function main() {
  initWorkspace();
  store.load();
  store.onDecided = wf.onApprovalDecided;
  factory.init(await createLLM(), config.defaultProfile);

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

  app.post<{ Body: { id: string } }>('/api/profile', async (req, reply) => {
    try {
      await factory.switchProfile(req.body.id);
      bus.emit({ t: 'snapshot', d: snapshot() });
      return ok;
    } catch (e: any) {
      return fail(reply, e.message);
    }
  });

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send() : reply.sendFile('index.html')));
  }

  await app.listen({ port: config.port, host: config.host });
  bus.log('info', `服务已启动 http://localhost:${config.port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
