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
  webDist: path.join(ROOT, 'apps/web/dist'),
  defaultProfile: process.env.COMPANY_PROFILE || 'software-dev',
  llm: {
    /** 没有 key 时进入演示模式：脚本驱动，但终端/浏览器/文件操作都是真实的 */
    provider: (process.env.LLM_PROVIDER || (apiKey ? 'openai' : 'mock')) as 'openai' | 'mock',
    apiKey,
    baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    maxSteps: Number(process.env.AGENT_MAX_STEPS || 60),
  },
  browserHeadless: process.env.BROWSER_HEADLESS !== 'false',
};
