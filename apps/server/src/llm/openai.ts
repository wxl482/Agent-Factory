import OpenAI from 'openai';
import { config } from '../config.js';
import type { ChatMessage, LLM, LLMResult, StreamCallbacks, ToolCall, ToolSpec } from './types.js';

/** OpenAI 兼容协议客户端（DeepSeek / 其他兼容服务均可） */
export class OpenAICompatLLM implements LLM {
  private client = new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseURL });

  async listModels(): Promise<string[]> {
    const res = await this.client.models.list();
    return res.data.map((m) => m.id);
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], cb: StreamCallbacks, _ctx: unknown, signal?: AbortSignal): Promise<LLMResult> {
    const stream = await this.client.chat.completions.create(
      {
        model: config.llm.model,
        messages: messages as any,
        tools: tools.map((t) => ({ type: 'function' as const, function: t })),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    let content = '';
    let reasoning = '';
    const calls: ToolCall[] = [];
    let usage = { input: 0, output: 0 };

    for await (const chunk of stream) {
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
      const delta: any = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        cb.onReasoning(delta.reasoning_content);
      }
      if (delta.content) {
        content += delta.content;
        cb.onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) {
          calls[i].function.arguments += tc.function.arguments;
          cb.onToolArgs(calls[i].function.name, calls[i].function.arguments);
        }
      }
    }

    const message: LLMResult['message'] = { role: 'assistant', content: content || null };
    const toolCalls = calls.filter(Boolean);
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (reasoning) message.reasoning_content = reasoning;
    return { message, usage };
  }
}
