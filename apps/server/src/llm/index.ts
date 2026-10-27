import { store } from '../store.js';
import { usage } from '../usage.js';
import type { CompleteRequest, LLM } from './types.js';

/** 当前使用的模型实例（启动时由 index.ts 设置），供工具、会议等旁路调用使用 */
let current: LLM | null = null;

export function setLLM(llm: LLM) {
  current = llm;
}

export function getLLM(): LLM {
  if (!current) throw new Error('LLM 尚未初始化');
  return current;
}

/** 以某个员工的身份做一次单轮调用，并把 token 记到该员工头上 */
export async function completeAs(agentId: string, roleId: string, req: CompleteRequest) {
  const res = await getLLM().complete(req, { agentId, roleId });
  const a = store.agents.get(agentId);
  if (a) store.setAgent(agentId, { tokens: { input: a.tokens.input + res.usage.input, output: a.tokens.output + res.usage.output } });
  usage.record(agentId, a?.currentTaskId ?? null, res.usage);
  return res.text;
}
