import { useSyncExternalStore } from 'react';
import type { EditorState } from '@af/shared';

/**
 * 高频实时数据（终端字节流、浏览器画面帧、编辑器、思考流）不进 React 全局状态，
 * 而是按 agentId 订阅，避免整页重渲染。
 */

type Fn = () => void;

class Channel<T> {
  private data = new Map<string, T>();
  private subs = new Map<string, Set<Fn>>();
  constructor(private empty: T) {}

  get(id: string): T {
    return this.data.get(id) ?? this.empty;
  }
  set(id: string, v: T) {
    this.data.set(id, v);
    this.subs.get(id)?.forEach((f) => f());
  }
  subscribe(id: string, fn: Fn) {
    let s = this.subs.get(id);
    if (!s) this.subs.set(id, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  clear() {
    const ids = [...this.data.keys()];
    this.data.clear();
    ids.forEach((id) => this.subs.get(id)?.forEach((f) => f()));
  }
}

export interface Frame {
  data: string;
  url: string;
}
export interface Cursor {
  x: number;
  y: number;
  action: 'click' | 'type';
  ts: number;
}

export const frames = new Channel<Frame | null>(null);
export const editors = new Channel<EditorState | null>(null);
export const thoughts = new Channel<string>('');
export const cursors = new Channel<Cursor | null>(null);

/** 终端：保留完整缓冲（新挂载的 xterm 需要回放），并对增量做发布 */
class TermChannel {
  private buf = new Map<string, string>();
  private subs = new Map<string, Set<(chunk: string) => void>>();
  get(id: string) {
    return this.buf.get(id) ?? '';
  }
  set(id: string, all: string) {
    this.buf.set(id, all);
  }
  append(id: string, chunk: string) {
    let b = (this.buf.get(id) ?? '') + chunk;
    if (b.length > 300_000) b = b.slice(-200_000);
    this.buf.set(id, b);
    this.subs.get(id)?.forEach((f) => f(chunk));
  }
  subscribe(id: string, fn: (chunk: string) => void) {
    let s = this.subs.get(id);
    if (!s) this.subs.set(id, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  clear() {
    this.buf.clear();
  }
}
export const terms = new TermChannel();

export function useChannel<T>(ch: Channel<T>, id: string): T {
  return useSyncExternalStore(
    (fn) => ch.subscribe(id, fn),
    () => ch.get(id),
  );
}
