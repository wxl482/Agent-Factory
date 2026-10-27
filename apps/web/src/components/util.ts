import type { TaskStatus } from '@af/shared';
import { useStore } from '../lib/store';

export function agentName(id: string) {
  if (id === 'human') return '老板';
  if (id === 'system') return '系统';
  return useStore.getState().profile?.agents.find((a) => a.id === id)?.name ?? id;
}

export function agentColor(id: string | null) {
  const s = useStore.getState();
  const a = s.profile?.agents.find((x) => x.id === id);
  return s.profile?.roles.find((r) => r.id === a?.roleId)?.color ?? '#8a8fb8';
}

export const STATUS_CN: Record<TaskStatus, string> = {
  planning: '规划中',
  todo: '待办',
  in_progress: '进行中',
  review: '待评审',
  changes_requested: '返工中',
  blocked: '受阻',
  awaiting_human: '等老板',
  done: '完成',
  cancelled: '已取消',
};

export function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 花费：¥0.012 / ¥3.40 */
export function fmtCost(cost: number | undefined) {
  const c = cost ?? 0;
  const cur = useStore.getState().usage?.pricing.currency ?? '¥';
  return `${cur}${c.toFixed(c < 1 ? 3 : 2)}`;
}

/** 12.3k / 1.2M */
export function fmtTokens(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 时长：45 秒 / 12 分钟 / 2.5 小时 */
export function fmtDuration(ms: number) {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

export function fmtSize(b: number) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;
}

/** 稳定的空数组，避免 zustand 选择器每次返回新引用导致死循环 */
export const NONE: never[] = [];

export const PRIORITY_COLOR: Record<'P0' | 'P1' | 'P2' | 'P3', string> = { P0: '#ef4444', P1: '#fb923c', P2: '#60a5fa', P3: '#9ca3af' };

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 10-27 14:03 */
export function fmtAgo(ts: number) {
  const d = Math.max(0, Date.now() - ts) / 1000;
  if (d < 45) return '刚刚';
  if (d < 3600) return `${Math.round(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.round(d / 3600)} 小时前`;
  const t = new Date(ts);
  return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}
