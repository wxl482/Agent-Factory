import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const apiKey = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  /** 访问口令；部署到服务器时建议设置 */
  accessToken: process.env.ACCESS_TOKEN || '',
  workspace: path.resolve(ROOT, process.env.WORKSPACE_DIR || 'workspace'),
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  profilesDir: path.join(ROOT, 'company/profiles'),
  skillsDir: path.join(ROOT, 'company/skills'),
  webDist: path.join(ROOT, 'apps/web/dist'),
  defaultProfile: process.env.COMPANY_PROFILE || 'software-dev',
  /** PostgreSQL 连接串；不填或连接失败时自动降级到本地原子 JSON 存储 */
  databaseUrl: process.env.DATABASE_URL || 'postgres://af:af_password@localhost:5433/agent_factory',
  llm: {
    /** 没有 key 时进入演示模式：脚本驱动，但终端/浏览器/文件操作都是真实的 */
    provider: (process.env.LLM_PROVIDER || (apiKey ? 'openai' : 'mock')) as 'openai' | 'mock',
    apiKey,
    baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    fallbackModel: process.env.LLM_FALLBACK_MODEL || '',
    maxSteps: Number(process.env.AGENT_MAX_STEPS || 60),
    chunkTimeoutMs: Number(process.env.LLM_CHUNK_TIMEOUT_MS || 45_000),
    totalTimeoutMs: Number(process.env.LLM_TOTAL_TIMEOUT_MS || 180_000),
  },
  /** 模型单价（每百万 token）。默认按 DeepSeek 官网价格量级填写，请以你的账单为准，在 .env 里覆盖 */
  pricing: {
    input: Number(process.env.LLM_PRICE_INPUT ?? 2),
    cacheHit: Number(process.env.LLM_PRICE_CACHE_HIT ?? 0.5),
    output: Number(process.env.LLM_PRICE_OUTPUT ?? 8),
    currency: process.env.LLM_PRICE_CURRENCY || '¥',
  },
  /** 预算初始值（0 = 不限）；之后可在界面「成本」面板里调整并持久化 */
  budget: {
    daily: Number(process.env.BUDGET_DAILY ?? 0),
    perGoal: Number(process.env.BUDGET_PER_GOAL ?? 0),
  },
  browserHeadless:process.env.BROWSER_HEADLESS !== 'false',
};
