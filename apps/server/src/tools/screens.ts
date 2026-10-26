import type { EditorState } from '@af/shared';
import { bus } from '../bus.js';

/** 编辑器 / 思考 两类屏幕内容的最新状态（终端和浏览器各自在模块内维护） */
const editors = new Map<string, EditorState>();
const thoughts = new Map<string, string>();

export function emitEditor(agentId: string, d: EditorState) {
  editors.set(agentId, d);
  bus.emit({ t: 'editor', agentId, d });
}

export function emitThought(agentId: string, text: string, reset = false) {
  const prev = reset ? '' : thoughts.get(agentId) ?? '';
  const next = (prev + text).slice(-8000);
  thoughts.set(agentId, next);
  bus.emit({ t: 'thought', agentId, text, reset });
}

export function screenSnapshot() {
  return { editors: Object.fromEntries(editors), thoughts: Object.fromEntries(thoughts) };
}

export function clearScreens() {
  editors.clear();
  thoughts.clear();
}
