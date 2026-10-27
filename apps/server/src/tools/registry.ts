import type { CustomToolDef, Risk, ScreenMode, ToolGroup } from '@af/shared';
import { company } from '../company.js';
import type { ToolSpec } from '../llm/types.js';

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

export interface ToolDef {
  group: ToolGroup[];
  spec: ToolSpec;
  risk?: Risk;
  run(ctx: ToolContext, args: any): Promise<ToolResult | string>;
}

const BUILTIN_TOOLS = new Map<string, ToolDef>();
const CUSTOM_TOOLS = new Map<string, ToolDef>();

export function registerBuiltinTools(defs: Record<string, ToolDef>) {
  for (const [name, def] of Object.entries(defs)) {
    BUILTIN_TOOLS.set(name, def);
  }
}

export function registerTool(name: string, def: ToolDef) {
  CUSTOM_TOOLS.set(name, def);
}

/** 从公司配置动态挂载外部 HTTP / MCP 桥接工具 */
export function registerCustomTools(customDefs: CustomToolDef[] = []) {
  CUSTOM_TOOLS.clear();
  for (const c of customDefs) {
    CUSTOM_TOOLS.set(c.name, {
      group: c.group?.length ? c.group : ['worker'],
      risk: c.risk ?? 'R0',
      spec: {
        name: c.name,
        description: c.description,
        parameters: c.parameters ?? { type: 'object', properties: {} },
      },
      async run(ctx, args) {
        ctx.setScreen('thinking', `调用外部工具 ${c.name}`);
        const method = c.method ?? 'POST';
        const url = method === 'GET' && args ? `${c.endpoint}${c.endpoint.includes('?') ? '&' : '?'}${new URLSearchParams(args).toString()}` : c.endpoint;
        const res = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json', ...(c.headers ?? {}) },
          ...(method === 'POST' ? { body: JSON.stringify({ agentId: ctx.agentId, taskId: ctx.taskId, arguments: args }) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        return text;
      },
    });
  }
}

export function getTool(name: string): ToolDef | undefined {
  return CUSTOM_TOOLS.get(name) ?? BUILTIN_TOOLS.get(name);
}

export function toolsForRole(groups: ToolGroup[]): ToolSpec[] {
  const all = [...BUILTIN_TOOLS.values(), ...CUSTOM_TOOLS.values()];
  return all.filter((t) => t.group.some((g) => groups.includes(g))).map((t) => t.spec);
}

/** 按公司风险规则判定工具调用的风险等级 */
export function classifyRisk(tool: string, args: any): { risk: Risk; reason: string } {
  const custom = CUSTOM_TOOLS.get(tool);
  let best: { risk: Risk; reason: string } = {
    risk: custom?.risk ?? 'R0',
    reason: custom?.risk && custom.risk !== 'R0' ? `外部工具 ${tool} 预设风险` : '',
  };
  const subject = tool === 'run_command' ? String(args?.command ?? '') : JSON.stringify(args ?? {});
  for (const r of company.profile.policy.rules) {
    if (r.tool !== tool && r.tool !== '*') continue;
    if (r.pattern && !new RegExp(r.pattern, 'i').test(subject)) continue;
    if (r.risk > best.risk) best = { risk: r.risk, reason: r.reason };
  }
  return best;
}
