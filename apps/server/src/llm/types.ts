export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamCallbacks {
  onText(delta: string): void;
  onReasoning(delta: string): void;
  /** 工具调用参数流式到达（用于实时显示正在写的代码） */
  onToolArgs(name: string, argsSoFar: string): void;
}

export interface LLMResult {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  usage: TokenUsage;
}

/** cacheHit：输入里命中服务端缓存的部分（DeepSeek 等按更低单价计费） */
export interface TokenUsage {
  input: number;
  output: number;
  cacheHit?: number;
  model?: string;
}

export interface LLMContext {
  agentId: string;
  roleId: string;
}

/** 单轮非流式调用的用途：决定演示模式下返回什么，真实模型下不影响行为 */
export type CompleteKind = 'route_check' | 'meeting_open' | 'meeting_speak' | 'meeting_summary' | 'consult';

export interface CompleteRequest {
  kind: CompleteKind;
  system: string;
  user: string;
  /** 要求输出 JSON 对象 */
  json?: boolean;
  maxTokens?: number;
}

export interface LLM {
  chat(messages: ChatMessage[], tools: ToolSpec[], cb: StreamCallbacks, ctx: LLMContext, signal?: AbortSignal): Promise<LLMResult>;
  /** 单轮补全：派单校验、会议发言、同事答疑等“旁路”调用 */
  complete(req: CompleteRequest, ctx: LLMContext): Promise<{ text: string; usage: TokenUsage }>;
}
