// ============ 公司配置（业务可插拔） ============

export type ToolGroup = 'fs' | 'fs_read' | 'terminal' | 'browser' | 'worker' | 'manager';
export type Risk = 'R0' | 'R1' | 'R2';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface RoleDef {
  id: string;
  name: string;
  /** 像素小人衬衫颜色 */
  color: string;
  tools: ToolGroup[];
  prompt: string;
}

export interface AgentDef {
  id: string;
  name: string;
  roleId: string;
  /** 头发颜色，区分同角色的不同员工 */
  hair?: string;
}

export interface RiskRule {
  tool: string;
  /** 匹配工具参数（JSON 字符串）的正则 */
  pattern?: string;
  risk: Risk;
  reason: string;
}

export interface CompanyProfile {
  id: string;
  name: string;
  description: string;
  managerRoleId: string;
  roles: RoleDef[];
  agents: AgentDef[];
  policy: {
    maxReviewRounds: number;
    requireHumanAcceptance: boolean;
    rules: RiskRule[];
  };
}

// ============ 运行时状态 ============

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'paused' | 'error';
export type ScreenMode = 'idle' | 'thinking' | 'editor' | 'terminal' | 'browser';

export interface AgentState {
  id: string;
  name: string;
  roleId: string;
  status: AgentStatus;
  screen: ScreenMode;
  paused: boolean;
  currentTaskId: string | null;
  /** 当前在干什么的一句话 */
  activity: string;
  tokens: { input: number; output: number };
}

export type TaskStatus =
  | 'planning'
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'changes_requested'
  | 'blocked'
  | 'awaiting_human'
  | 'done'
  | 'cancelled';

export interface Task {
  id: string;
  kind: 'goal' | 'task';
  title: string;
  description: string;
  priority: Priority;
  status: TaskStatus;
  parentId: string | null;
  assigneeRoleId: string | null;
  assigneeAgentId: string | null;
  dependsOn: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  reviewRounds: number;
  /** 最近一次提交的工作总结 */
  result: string;
  /** 最近一次评审/老板反馈 */
  feedback: string;
}

export type ApprovalKind = 'tool' | 'question' | 'acceptance';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  taskId: string | null;
  requesterId: string;
  approver: 'manager' | 'human';
  risk: Risk;
  title: string;
  detail: string;
  tool?: string;
  args?: unknown;
  options?: string[];
  status: ApprovalStatus;
  decidedBy?: string;
  comment?: string;
  createdAt: number;
  decidedAt?: number;
}

export type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  agentId: string | null;
  taskId: string | null;
  text: string;
}

export interface EditorState {
  path: string;
  content: string;
  done: boolean;
}

// ============ WebSocket 协议（服务端 → 前端） ============

export interface Snapshot {
  profile: CompanyProfile;
  profiles: { id: string; name: string }[];
  llm: { provider: string; model: string };
  agents: AgentState[];
  tasks: Task[];
  approvals: Approval[];
  logs: LogEntry[];
  terminals: Record<string, string>;
  frames: Record<string, { data: string; url: string }>;
  editors: Record<string, EditorState>;
  thoughts: Record<string, string>;
  globalPaused: boolean;
}

export type ServerMsg =
  | { t: 'snapshot'; d: Snapshot }
  | { t: 'agent'; d: AgentState }
  | { t: 'task'; d: Task }
  | { t: 'approval'; d: Approval }
  | { t: 'log'; d: LogEntry }
  | { t: 'term'; agentId: string; data: string }
  | { t: 'frame'; agentId: string; data: string; url: string }
  | { t: 'cursor'; agentId: string; x: number; y: number; action: 'click' | 'type' }
  | { t: 'editor'; agentId: string; d: EditorState }
  | { t: 'thought'; agentId: string; text: string; reset?: boolean }
  | { t: 'paused'; d: boolean };

export const TERM_COLS = 110;
export const TERM_ROWS = 32;
export const BROWSER_W = 1024;
export const BROWSER_H = 640;

export const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
