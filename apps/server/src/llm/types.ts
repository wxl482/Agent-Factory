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
  usage: { input: number; output: number };
}

export interface LLMContext {
  agentId: string;
  roleId: string;
}

export interface LLM {
  chat(messages: ChatMessage[], tools: ToolSpec[], cb: StreamCallbacks, ctx: LLMContext, signal?: AbortSignal): Promise<LLMResult>;
}
