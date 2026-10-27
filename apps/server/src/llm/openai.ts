import OpenAI from 'openai';
import { company } from '../company.js';
import { config } from '../config.js';
import type { ChatMessage, CompleteRequest, LLM, LLMContext, LLMResult, StreamCallbacks, TokenUsage, ToolCall, ToolSpec } from './types.js';

/** DeepSeek 返回 prompt_cache_hit_tokens，OpenAI 返回 prompt_tokens_details.cached_tokens */
function toUsage(u: any, model: string): TokenUsage {
  return {
    input: u?.prompt_tokens ?? 0,
    output: u?.completion_tokens ?? 0,
    cacheHit: u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0,
    model,
  };
}

/** 按角色路由模型：优先使用角色配置的 model，否则使用全局默认模型 */
export function resolveModel(ctx?: LLMContext): string {
  if (ctx?.roleId && company.profile) {
    try {
      const r = company.role(ctx.roleId);
      if (r?.model?.trim()) return r.model.trim();
    } catch {}
  }
  return config.llm.model;
}

/** OpenAI 兼容协议客户端（支持按角色多模型路由、首包/流式超时熔断、备用模型自动切换） */
export class OpenAICompatLLM implements LLM {
  private client = new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseURL });

  async listModels(): Promise<string[]> {
    const res = await this.client.models.list();
    return res.data.map((m) => m.id);
  }

  async complete(req: CompleteRequest, ctx?: LLMContext) {
    const primary = resolveModel(ctx);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('LLM 单轮请求超时')), config.llm.chunkTimeoutMs);
    try {
      const res = await this.client.chat.completions.create(
        {
          model: primary,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens ?? 600,
          ...(req.json ? { response_format: { type: 'json_object' as const } } : {}),
        },
        { signal: ac.signal },
      );
      return {
        text: res.choices[0]?.message?.content?.trim() ?? '',
        usage: toUsage(res.usage, primary),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], cb: StreamCallbacks, ctx: LLMContext, signal?: AbortSignal): Promise<LLMResult> {
    const primary = resolveModel(ctx);
    const fallback = config.llm.fallbackModel || (primary !== config.llm.model ? config.llm.model : '');
    try {
      return await this.chatWithModel(primary, messages, tools, cb, signal);
    } catch (e) {
      if (fallback && fallback !== primary && !signal?.aborted) {
        return await this.chatWithModel(fallback, messages, tools, cb, signal);
      }
      throw e;
    }
  }

  private async chatWithModel(
    model: string,
    messages: ChatMessage[],
    tools: ToolSpec[],
    cb: StreamCallbacks,
    outerSignal?: AbortSignal,
  ): Promise<LLMResult> {
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort(outerSignal?.reason);
    outerSignal?.addEventListener('change', onOuterAbort);
    outerSignal?.addEventListener('abort', onOuterAbort);

    const totalTimer = setTimeout(() => ac.abort(new Error(`LLM 流式总耗时超过 ${Math.round(config.llm.totalTimeoutMs / 1000)}s 超时`)), config.llm.totalTimeoutMs);
    let chunkTimer = setTimeout(() => ac.abort(new Error(`LLM 首包响应超过 ${Math.round(config.llm.chunkTimeoutMs / 1000)}s 超时`)), config.llm.chunkTimeoutMs);
    const resetChunkTimer = () => {
      clearTimeout(chunkTimer);
      chunkTimer = setTimeout(() => ac.abort(new Error(`LLM 流式分片停滞超过 ${Math.round(config.llm.chunkTimeoutMs / 1000)}s 超时`)), config.llm.chunkTimeoutMs);
    };

    try {
      const stream = await this.client.chat.completions.create(
        {
          model,
          messages: messages as any,
          tools: tools.map((t) => ({ type: 'function' as const, function: t })),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: ac.signal },
      );

      let content = '';
      let reasoning = '';
      const calls: ToolCall[] = [];
      let usage: TokenUsage = { input: 0, output: 0, model };

      for await (const chunk of stream) {
        resetChunkTimer();
        if (chunk.usage) usage = toUsage(chunk.usage, model);
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
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(chunkTimer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
