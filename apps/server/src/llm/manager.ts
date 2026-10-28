import fs from 'node:fs';
import path from 'node:path';
import type { LlmInfo } from '@af/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { MockLLM } from './mock.js';
import { OpenAICompatLLM } from './openai.js';
import type { LLM } from './types.js';

/**
 * 模型管理：老板在界面里填 Key / 地址 / 模型名，测试通过后立即切换，不用改 .env、不用重启。
 * - 所有地方拿到的都是同一个 SwitchableLLM，切换时只替换里面的实例，正在跑的员工下一步就用上新模型
 * - Key 单独存 data/llm.json（权限 600），不进 settings、不广播给前端，只给掩码提示
 * - 界面保存过的配置优先于 .env
 */

const FILE = path.join(config.dataDir, 'llm.json');

interface Saved {
  apiKey: string;
  baseURL: string;
  model: string;
  pricing?: { input: number; cacheHit: number; output: number };
  /** 老板主动切回了演示模式 */
  demo?: boolean;
}

export interface LlmForm {
  /** 空 = 沿用已保存的 Key */
  apiKey?: string;
  baseURL: string;
  model: string;
  pricing?: { input: number; cacheHit: number; output: number };
}

class SwitchableLLM implements LLM {
  constructor(public inner: LLM) {}
  chat(...a: Parameters<LLM['chat']>) {
    return this.inner.chat(...a);
  }
  complete(...a: Parameters<LLM['complete']>) {
    return this.inner.complete(...a);
  }
}

function keyHint(k: string) {
  if (!k) return '';
  return k.length <= 8 ? '••••' : `${k.slice(0, 3)}…${k.slice(-4)}`;
}

function cleanUrl(u: string) {
  const v = u.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) throw new Error('接口地址需要以 http:// 或 https:// 开头');
  return v;
}

/** 把服务商返回的报错翻译成老板看得懂的话 */
function explain(e: any): string {
  const status = e?.status ?? e?.response?.status;
  const msg = String(e?.error?.message ?? e?.message ?? e);
  if (status === 401 || /invalid.*(api|key)|unauthor|incorrect api key/i.test(msg)) return 'API Key 不正确或已失效';
  if (status === 402 || /insufficient|balance|quota|余额/i.test(msg)) return '账户余额不足或额度用完';
  if (status === 404 || /model.*(not|does not) exist|no such model|model_not_found/i.test(msg)) return `模型名不存在，请检查拼写（${msg.slice(0, 80)}）`;
  if (status === 429) return '请求太频繁，被服务商限流，稍后再试';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|fetch failed|Connection error/i.test(msg)) return `连不上接口地址，请检查地址和网络（${msg.slice(0, 80)}）`;
  return msg.slice(0, 200);
}

class LlmManager {
  readonly llm = new SwitchableLLM(new MockLLM());
  private saved: Saved | null = null;

  /** 启动：读取界面保存过的配置（优先于 .env），然后建立模型实例 */
  async boot() {
    try {
      if (fs.existsSync(FILE)) this.saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      console.error('读取 llm.json 失败', e);
    }
    const s = this.saved;
    if (s && !process.env.LLM_PROVIDER) {
      // 演示模式下也要载入已保存的 Key/地址，之后在界面里不填 Key 就能一键切回
      if (s.apiKey) Object.assign(config.llm, { apiKey: s.apiKey, baseURL: s.baseURL, model: s.model });
      config.llm.provider = s.demo || !s.apiKey ? 'mock' : 'openai';
      if (s.pricing) Object.assign(config.pricing, s.pricing);
    }
    if (config.llm.provider === 'mock') {
      bus.log('warn', '当前是演示模式：剧本驱动，不消耗 token；终端、浏览器、文件操作都是真实执行。点顶栏模型名可以接入真实模型');
      return;
    }
    const real = new OpenAICompatLLM();
    this.llm.inner = real;
    try {
      const models = await real.listModels();
      bus.log('info', `模型服务可用模型：${models.slice(0, 20).join(', ')}；当前使用 ${config.llm.model}`);
      if (models.length && !models.includes(config.llm.model)) bus.log('warn', `模型 ${config.llm.model} 不在可用列表中，请在「模型设置」里检查`);
    } catch (e) {
      bus.log('warn', `无法获取模型列表：${explain(e)}`);
    }
  }

  info(): LlmInfo {
    const mock = config.llm.provider === 'mock';
    return { provider: config.llm.provider, model: mock ? '演示模式' : config.llm.model, baseURL: config.llm.baseURL, keyHint: keyHint(config.llm.apiKey) };
  }

  /** 测试连接：不改动正在使用的模型。返回可用模型列表（服务商支持的话） */
  async test(form: LlmForm): Promise<{ ok: boolean; error?: string; models: string[] }> {
    const apiKey = form.apiKey?.trim() || config.llm.apiKey;
    if (!apiKey) return { ok: false, error: '请填写 API Key', models: [] };
    let baseURL: string;
    try {
      baseURL = cleanUrl(form.baseURL);
    } catch (e: any) {
      return { ok: false, error: e.message, models: [] };
    }
    const client = new OpenAICompatLLM({ apiKey, baseURL });
    // 模型列表接口不是所有服务商都支持，失败不算错
    const models = await client.listModels().catch(() => [] as string[]);
    if (!form.model?.trim()) return { ok: models.length > 0, error: models.length ? undefined : '请填写模型名', models };
    try {
      await client.ping(form.model.trim());
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: explain(e), models };
    }
  }

  /** 保存并立即切换（先测试，通不过不切换） */
  async apply(form: LlmForm): Promise<LlmInfo> {
    const r = await this.test(form);
    if (!r.ok) throw new Error(r.error ?? '连接失败');
    const apiKey = form.apiKey?.trim() || config.llm.apiKey;
    const baseURL = cleanUrl(form.baseURL);
    const model = form.model.trim();
    const pricing = form.pricing && Object.values(form.pricing).every((v) => typeof v === 'number' && v >= 0) ? form.pricing : undefined;
    Object.assign(config.llm, { provider: 'openai', apiKey, baseURL, model });
    if (pricing) Object.assign(config.pricing, pricing);
    this.llm.inner = new OpenAICompatLLM();
    this.persist({ apiKey, baseURL, model, pricing: pricing ?? config.pricing, demo: false });
    bus.log('success', `已切换到真实模型 ${model}（${baseURL}）`);
    bus.emit({ t: 'llm', d: this.info() });
    return this.info();
  }

  /** 切回演示模式（保留已保存的 Key，之后可以一键切回） */
  useDemo(): LlmInfo {
    config.llm.provider = 'mock';
    this.llm.inner = new MockLLM();
    this.persist({ ...(this.saved ?? { apiKey: config.llm.apiKey, baseURL: config.llm.baseURL, model: config.llm.model }), demo: true });
    bus.log('warn', '已切回演示模式');
    bus.emit({ t: 'llm', d: this.info() });
    return this.info();
  }

  private persist(s: Saved) {
    this.saved = s;
    fs.writeFileSync(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.chmodSync(FILE, 0o600);
  }
}

export const llmManager = new LlmManager();
