// ============ 公司配置（业务可插拔） ============

export type ToolGroup = 'fs' | 'fs_read' | 'terminal' | 'browser' | 'worker' | 'manager';
export type Risk = 'R0' | 'R1' | 'R2';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface RoleDef {
  id: string;
  name: string;
  /** 角色色（奶蛙项圈颜色） */
  color: string;
  tools: ToolGroup[];
  prompt: string;
  /** 可选：该角色专用的模型名称（不填则使用全局默认模型） */
  model?: string;
  /** 可选：挂载的技能包 id（对应 company/skills/<id>/SKILL.md） */
  skills?: string[];
  /** 可选：单次循环最大步数上限 */
  maxSteps?: number;
  /** 岗位职责卡：经理派单、派单校验、员工退单都依据它 */
  description?: string;
  responsibilities?: string[];
  outOfScope?: string[];
  deliverables?: string[];
}

export interface CustomToolDef {
  name: string;
  description: string;
  group?: ToolGroup[];
  parameters?: Record<string, unknown>;
  /** HTTP/MCP 远程调用地址 */
  endpoint: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  risk?: Risk;
}

export interface AgentDef {
  id: string;
  name: string;
  roleId: string;
  /** 头发颜色，区分同角色的不同员工 */
  hair?: string;
  departmentId?: string;
}

export interface DepartmentDef {
  id: string;
  name: string;
  /** office = 独立办公室（经理室），open = 开放办公区 */
  kind: 'office' | 'open';
}

export interface RiskRule {
  tool: string;
  /** 匹配工具参数（JSON 字符串）的正则 */
  pattern?: string;
  risk: Risk;
  reason: string;
}

/** 动画动作：程序按员工实时状态选择播放哪一段 */
export type AvatarAction = 'idle' | 'walk' | 'sit' | 'type' | 'mouse' | 'think' | 'talk' | 'phone' | 'drink' | 'wait' | 'sleep';

/** 外部员工模型（GLB/glTF/FBX/OBJ）。不配置则用内置的程序化奶蛙 */
export interface AvatarModelConfig {
  /** 模型地址，放在 company/models/ 下即可用 /models/xxx.glb 访问 */
  url: string;
  /** 站立时的身高（米），模型会自动缩放到这个高度；默认 1.25 */
  height?: number;
  /** 直接指定缩放（优先于 height） */
  scale?: number;
  /** 绕 Y 轴旋转（弧度），用来让模型正面朝 -Z（屏幕方向） */
  rotationY?: number;
  /** 项圈材质名（正则），会按角色改颜色；默认 collar|项圈 */
  collarMaterial?: string;
  /** 没有坐姿动画时，坐下时把模型抬高多少（米） */
  sitLift?: number;
  /** 动作 → 模型里的动画名；不写则按名字关键词自动匹配 */
  clips?: Partial<Record<AvatarAction, string>>;
}

/** 下达目标的模板：新手不知道怎么写目标时一键填好结构，【】里是需要改成自己内容的地方 */
export interface GoalTemplate {
  icon: string;
  /** 卡片上显示的短名，例如「小红书文案」 */
  label: string;
  title: string;
  description: string;
  priority?: Priority;
}

export interface CompanyProfile {
  id: string;
  name: string;
  description: string;
  managerRoleId: string;
  /** 下达目标的模板，显示在新手引导和「下达目标」弹窗里 */
  goalTemplates?: GoalTemplate[];
  /** 部门（每个部门是办公室里的一个房间）；不配置则所有人在同一个办公区 */
  departments?: DepartmentDef[];
  roles: RoleDef[];
  agents: AgentDef[];
  /** 员工外观模型（所有员工共用，项圈颜色按角色区分） */
  avatar?: AvatarModelConfig;
  /** 可插拔外部工具（HTTP / MCP 桥接） */
  customTools?: CustomToolDef[];
  policy: {
    maxReviewRounds: number;
    requireHumanAcceptance: boolean;
    rules: RiskRule[];
  };
}

// ============ 运行时状态 ============

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'paused' | 'error';

/** 员工在办公室里的位置：工位 / 会议室 / 经理室 / 同事工位旁 / 茶水间 */
export type PlaceKind = 'desk' | 'meeting' | 'office' | 'visit' | 'pantry';
export interface AgentLocation {
  kind: PlaceKind;
  /** office/visit：去找的人；meeting：会议 id */
  target?: string;
  /** 会议座位号 / 茶水间站位 */
  seat?: number;
  /** 一句话说明，例如“找老周请示” */
  reason?: string;
}
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
  location: AgentLocation;
  /** 正在说的话（对话气泡），说完一段时间后清空 */
  speech: string | null;
}

export interface MeetingLine {
  agentId: string;
  text: string;
  ts: number;
}

export interface Meeting {
  id: string;
  topic: string;
  agenda: string;
  hostId: string;
  participants: string[];
  status: 'gathering' | 'ongoing' | 'done';
  transcript: MeetingLine[];
  summary: string;
  taskId: string | null;
  createdAt: number;
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
  /** 验收标准（子任务必填） */
  acceptance: string;
  /** 会议纪要等协作记录（目标上） */
  notes: string[];
  /** 老板要求先问清楚需求再开工（目标上） */
  clarify?: boolean;
  /** 这个任务写过/改过的工作区文件（相对路径），交付页据此列出产出 */
  artifacts: string[];
  /** 首次开工、完成（done/cancelled）的时间，用于统计耗时 */
  startedAt?: number;
  finishedAt?: number;
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
  /** 预算类请示：超出每日 / 单目标预算时由系统发起 */
  budget?: { scope: 'daily' | 'goal'; goalId?: string };
  /** 由超时规则自动处理 */
  autoDecided?: boolean;
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

// ============ 成本 ============

/** 一组调用的用量与花费 */
export interface Usage {
  /** 输入 token（含缓存命中部分） */
  input: number;
  /** 其中命中缓存的输入 token */
  cacheHit: number;
  output: number;
  /** 花费（单位见 UsageStats.currency） */
  cost: number;
  calls: number;
}

export interface Pricing {
  /** 每百万 token 单价 */
  input: number;
  cacheHit: number;
  output: number;
  currency: string;
}

/** 预算（0 = 不限） */
export interface Budget {
  daily: number;
  perGoal: number;
}

export interface UsageStats {
  pricing: Pricing;
  /** 演示模式：token 是估算的 */
  simulated: boolean;
  budget: Budget;
  /** 今天（服务器本地日期 YYYY-MM-DD） */
  today: string;
  total: Usage;
  byDay: Record<string, Usage>;
  byAgent: Record<string, Usage>;
  byGoal: Record<string, Usage>;
  byTask: Record<string, Usage>;
  byDayAgent?: Record<string, Record<string, Usage>>;
  byModel?: Record<string, Usage>;
  /** 老板批准追加的额度：今日 / 各目标 */
  extraToday: number;
  extraGoal: Record<string, number>;
  /** 因超预算而暂停、等待老板决定的目标 */
  heldGoals: string[];
}

/** 交付页里一个产出文件的信息 */
export interface ArtifactFile {
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  /** 哪些子任务产出/修改过它 */
  taskIds: string[];
}

// ============ 公司规则（老板可在界面里改，存在 data/settings.json） ============

/** 谁来审批：auto 直接放行 / manager 经理 / human 老板 */
export type Approver = 'auto' | 'manager' | 'human';

export type NotifyEvent = 'decision' | 'acceptance' | 'budget' | 'goal_done' | 'blocked';

export interface Settings {
  approval: {
    /** R1 中风险操作（装依赖、递归删除…） */
    r1: Approver;
    /** R2 高风险操作（sudo、git push、发布…），不允许 auto */
    r2: Exclude<Approver, 'auto'>;
    /** 目标交付是否需要老板验收；false = 经理确认即完成 */
    humanAcceptance: boolean;
  };
  /** 老板长时间没处理的事项怎么办（分钟，0 = 一直等） */
  timeout: {
    minutes: number;
    /** 操作审批超时：驳回（安全默认） */
    toolAction: 'reject';
    /** 请示超时：授权经理按最佳判断推进 */
    questionAction: 'delegate' | 'wait';
  };
  notify: {
    /** 飞书 / 企业微信 / 钉钉群机器人，或任意接收 JSON 的地址；空 = 不推送 */
    webhook: string;
    /** 消息里附带的访问地址，例如 http://服务器:8787 */
    publicUrl: string;
    events: NotifyEvent[];
  };
  /** 聊天平台（钉钉应用机器人等）：可以在群里/单聊里 @ 机器人下指令 */
  im: {
    /** 可以下指令（派活、审批、暂停）的钉钉 userId；其他人只能查状态 */
    dingtalkAdmins: string[];
  };
}

/** 聊天平台连接状态 */
export interface ImStatus {
  dingtalk: { state: 'off' | 'connecting' | 'online' | 'error'; detail?: string };
}

/** 当前模型配置（发给前端；永远不包含完整的 API Key） */
export interface LlmInfo {
  provider: 'openai' | 'mock' | string;
  model: string;
  baseURL?: string;
  /** 已保存的 Key 的掩码提示，例如 sk-…a1b2；空 = 未配置 */
  keyHint?: string;
}

// ============ WebSocket 协议（服务端 → 前端） ============

export interface Snapshot {
  profile: CompanyProfile;
  profiles: { id: string; name: string }[];
  llm: LlmInfo;
  agents: AgentState[];
  tasks: Task[];
  approvals: Approval[];
  logs: LogEntry[];
  terminals: Record<string, string>;
  frames: Record<string, { data: string; url: string }>;
  editors: Record<string, EditorState>;
  thoughts: Record<string, string>;
  meetings: Meeting[];
  globalPaused: boolean;
  usage: UsageStats;
  settings: Settings;
  im: ImStatus;
  /** 工作区文件只读预览地址前缀（带随机密钥），例如 /preview/xxxx/ */
  previewBase: string;
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
  | { t: 'meeting'; d: Meeting }
  | { t: 'paused'; d: boolean }
  | { t: 'usage'; d: UsageStats }
  | { t: 'settings'; d: Settings }
  | { t: 'im'; d: ImStatus }
  | { t: 'llm'; d: LlmInfo };

export const TERM_COLS = 102;
export const TERM_ROWS = 32;
export const BROWSER_W = 1024;
export const BROWSER_H = 640;

export const EMPTY_USAGE: Usage = { input: 0, cacheHit: 0, output: 0, cost: 0, calls: 0 };

export const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
