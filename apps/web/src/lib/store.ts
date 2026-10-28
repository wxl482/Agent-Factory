import { create } from 'zustand';
import type { AgentState, Approval, CompanyProfile, GoalTemplate, ImStatus, LogEntry, Meeting, ServerMsg, Settings, Snapshot, Task, UsageStats } from '@af/shared';
import { cursors, editors, frames, terms, thoughts } from './live';

interface State {
  connected: boolean;
  profile: CompanyProfile | null;
  profiles: Snapshot['profiles'];
  llm: Snapshot['llm'] | null;
  agents: Record<string, AgentState>;
  tasks: Record<string, Task>;
  approvals: Record<string, Approval>;
  meetings: Record<string, Meeting>;
  logs: LogEntry[];
  globalPaused: boolean;
  /** 打开了大屏的员工 */
  focusAgent: string | null;
  tab: 'inbox' | 'tasks' | 'logs';
  /** 右侧功能区是否收拢 */
  sideCollapsed: boolean;
  showNewGoal: boolean;
  /** 3D 办公室当前查看的部门（'all' = 全公司） */
  dept: string;
  /** 镜头走近的工位 */
  deskFocus: string | null;
  usage: UsageStats | null;
  previewBase: string;
  /** 打开交付页的目标 */
  deliveryGoal: string | null;
  showCost: boolean;
  settings: Settings | null;
  showRules: boolean;
  im: ImStatus | null;
  showModel: boolean;
  /** 打开「下达目标」时预填的内容（来自模板） */
  goalDraft: Pick<GoalTemplate, 'title' | 'description' | 'priority'> | null;
}

function savedDept() {
  try {
    return localStorage.getItem('af-dept') || 'all';
  } catch {
    return 'all';
  }
}

function savedSideCollapsed() {
  try {
    return localStorage.getItem('af-side-collapsed') === '1';
  } catch {
    return false;
  }
}

export const useStore = create<State>(() => ({
  connected: false,
  profile: null,
  profiles: [],
  llm: null,
  agents: {},
  tasks: {},
  approvals: {},
  meetings: {},
  logs: [],
  globalPaused: false,
  focusAgent: null,
  tab: 'logs',
  sideCollapsed: savedSideCollapsed(),
  showNewGoal: false,
  dept: savedDept(),
  deskFocus: null,
  usage: null,
  previewBase: '',
  deliveryGoal: null,
  showCost: false,
  settings: null,
  showRules: false,
  im: null,
  showModel: false,
  goalDraft: null,
}));

useStore.subscribe((s, prev) => {
  if (s.dept !== prev.dept) {
    try {
      localStorage.setItem('af-dept', s.dept);
    } catch {}
  }
  if (s.sideCollapsed !== prev.sideCollapsed) {
    try {
      localStorage.setItem('af-side-collapsed', s.sideCollapsed ? '1' : '0');
    } catch {}
  }
});

const set = useStore.setState;
const byId = <T extends { id: string }>(arr: T[]) => Object.fromEntries(arr.map((x) => [x.id, x]));

export function handleMessage(m: ServerMsg) {
  switch (m.t) {
    case 'snapshot': {
      const d = m.d;
      terms.clear();
      frames.clear();
      editors.clear();
      thoughts.clear();
      for (const [id, b] of Object.entries(d.terminals)) terms.set(id, b);
      for (const [id, f] of Object.entries(d.frames)) frames.set(id, f);
      for (const [id, e] of Object.entries(d.editors)) editors.set(id, e);
      for (const [id, t] of Object.entries(d.thoughts)) thoughts.set(id, t);
      const pending = d.approvals.some((a) => a.status === 'pending' && a.approver === 'human');
      set({
        profile: d.profile,
        profiles: d.profiles,
        llm: d.llm,
        agents: byId(d.agents),
        tasks: byId(d.tasks),
        approvals: byId(d.approvals),
        meetings: byId(d.meetings ?? []),
        logs: d.logs,
        globalPaused: d.globalPaused,
        usage: d.usage ?? null,
        previewBase: d.previewBase,
        settings: d.settings ?? null,
        im: d.im ?? null,
        // 有待决策就先看待决策；一个目标都没有时显示新手引导（在任务页）
        ...(pending ? { tab: 'inbox' as const } : !d.tasks.some((t) => t.kind === 'goal') ? { tab: 'tasks' as const } : {}),
      });
      break;
    }
    case 'agent':
      set((s) => ({ agents: { ...s.agents, [m.d.id]: m.d } }));
      break;
    case 'task':
      set((s) => ({ tasks: { ...s.tasks, [m.d.id]: m.d } }));
      break;
    case 'approval':
      set((s) => ({
        approvals: { ...s.approvals, [m.d.id]: m.d },
        ...(m.d.status === 'pending' && m.d.approver === 'human' ? { tab: 'inbox' as const } : {}),
      }));
      if (m.d.status === 'pending' && m.d.approver === 'human') notifyHuman(m.d);
      break;
    case 'log':
      set((s) => ({ logs: s.logs.length > 3000 ? [...s.logs.slice(-2000), m.d] : [...s.logs, m.d] }));
      break;
    case 'paused':
      set({ globalPaused: m.d });
      break;
    case 'llm':
      set({ llm: m.d });
      break;
    case 'im':
      set({ im: m.d });
      break;
    case 'settings':
      set({ settings: m.d });
      break;
    case 'usage':
      set({ usage: m.d });
      break;
    case 'meeting':
      set((s) => ({ meetings: { ...s.meetings, [m.d.id]: m.d } }));
      break;
    case 'term':
      terms.append(m.agentId, m.data);
      break;
    case 'frame':
      frames.set(m.agentId, { data: m.data, url: m.url });
      break;
    case 'cursor':
      cursors.set(m.agentId, { x: m.x, y: m.y, action: m.action, ts: Date.now() });
      break;
    case 'editor':
      editors.set(m.agentId, m.d);
      break;
    case 'thought':
      thoughts.set(m.agentId, m.reset ? m.text : (thoughts.get(m.agentId) + m.text).slice(-8000));
      break;
  }
}

/** 需要老板决策时：浏览器通知 + 标题闪烁 */
function notifyHuman(a: Approval) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification('Agent Factory：需要你决策', { body: a.title });
    }
  } catch {}
}
