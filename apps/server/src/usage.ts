import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_USAGE, type Budget, type Usage, type UsageStats } from '@af/shared';
import { bus } from './bus.js';
import { config } from './config.js';
import { db } from './db.js';
import { store } from './store.js';

/**
 * 成本账本：每次模型调用按 员工 / 任务 / 目标 / 天 累计 token 和花费，并执行预算。
 * - 每日预算用完：全公司暂停，请示老板是否追加今日额度
 * - 单目标预算用完：该目标的工作暂停，请示老板是否追加（驳回则取消目标）
 * 老板的决定由 workflow.onApprovalDecided 调用 grant* 处理。
 */

const FILE = path.join(config.dataDir, 'usage.json');
const KEEP_DAYS = 60;

type Persisted = Omit<UsageStats, 'pricing' | 'simulated' | 'today'> & { extraDay: string };

function localDay(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function add(map: Record<string, Usage>, key: string, u: Usage) {
  const cur = (map[key] ??= { ...EMPTY_USAGE });
  cur.input += u.input;
  cur.cacheHit += u.cacheHit;
  cur.output += u.output;
  cur.cost += u.cost;
  cur.calls += u.calls;
}

class UsageLedger {
  private s: Persisted = {
    budget: { daily: config.budget.daily, perGoal: config.budget.perGoal },
    total: { ...EMPTY_USAGE },
    byDay: {},
    byAgent: {},
    byGoal: {},
    byTask: {},
    byDayAgent: {},
    byModel: {},
    extraToday: 0,
    extraDay: localDay(),
    extraGoal: {},
    heldGoals: [],
  };
  private saveTimer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;

  async load() {
    if (db.ready) {
      const fromDb = await db.getKv<Persisted>('usage');
      if (fromDb && fromDb.total) {
        Object.assign(this.s, fromDb);
        this.s.byDayAgent ??= {};
        this.s.byModel ??= {};
        return;
      }
    }
    if (!fs.existsSync(FILE)) return;
    try {
      Object.assign(this.s, JSON.parse(fs.readFileSync(FILE, 'utf8')));
      this.s.byDayAgent ??= {};
      this.s.byModel ??= {};
      if (db.ready) db.setKv('usage', this.s);
    } catch (e) {
      console.error('加载 usage.json 失败', e);
    }
  }

  stats(): UsageStats {
    this.rollDay();
    const { extraDay: _, ...rest } = this.s;
    return { ...rest, pricing: config.pricing, simulated: config.llm.provider === 'mock', today: localDay() };
  }

  /** 任务所属目标（目标本身返回自己） */
  goalOf(taskId: string | null): string | null {
    const t = taskId ? store.tasks.get(taskId) : undefined;
    if (!t) return null;
    return t.kind === 'goal' ? t.id : t.parentId;
  }

  isGoalHeld(taskId: string | null) {
    const g = this.goalOf(taskId);
    return !!g && this.s.heldGoals.includes(g);
  }

  /** 记一次模型调用 */
  record(agentId: string, taskId: string | null, raw: { input: number; output: number; cacheHit?: number; model?: string }) {
    const p = config.pricing;
    const cacheHit = Math.min(raw.cacheHit ?? 0, raw.input);
    const u: Usage = {
      input: raw.input,
      cacheHit,
      output: raw.output,
      cost: ((raw.input - cacheHit) * p.input + cacheHit * p.cacheHit + raw.output * p.output) / 1e6,
      calls: 1,
    };
    this.rollDay();
    const day = localDay();
    this.s.total = sum(this.s.total, u);
    add(this.s.byDay, day, u);
    add(this.s.byAgent, agentId, u);
    this.s.byDayAgent ??= {};
    this.s.byDayAgent[day] ??= {};
    add(this.s.byDayAgent[day], agentId, u);
    this.s.byModel ??= {};
    add(this.s.byModel, raw.model || config.llm.model, u);
    if (taskId) add(this.s.byTask, taskId, u);
    const goal = this.goalOf(taskId);
    if (goal) add(this.s.byGoal, goal, u);
    this.checkBudget(goal);
    this.changed();
  }

  setBudget(b: Partial<Budget>) {
    const clean = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
    this.s.budget = { daily: clean(b.daily, this.s.budget.daily), perGoal: clean(b.perGoal, this.s.budget.perGoal) };
    bus.log('info', `老板调整预算：每日 ${fmt(this.s.budget.daily)}，单目标 ${fmt(this.s.budget.perGoal)}`);
    // 调高预算后，原本因超支暂停的目标可能可以放行了
    for (const g of [...this.s.heldGoals]) if (!this.goalOver(g)) this.release(g);
    this.changed();
  }

  /** 老板批准追加今日额度（再给一份每日预算），恢复全公司 */
  grantDaily(approved: boolean) {
    this.rollDay();
    if (approved) {
      this.s.extraToday += this.s.budget.daily;
      store.globalPaused = false;
      bus.emit({ t: 'paused', d: false });
      bus.log('success', `老板追加今日额度 ${fmt(this.s.budget.daily)}，全公司恢复工作`);
      store.onChangeNotify();
    } else {
      bus.log('warn', '老板未追加今日额度，公司保持暂停（可在成本面板调高预算或手动恢复）');
    }
    this.changed();
  }

  /** 老板对某个超支目标的决定：批准则追加一份单目标预算；驳回由 workflow 取消目标 */
  grantGoal(goalId: string, approved: boolean) {
    if (approved) this.s.extraGoal[goalId] = (this.s.extraGoal[goalId] ?? 0) + this.s.budget.perGoal;
    this.release(goalId);
    this.changed();
  }

  // ---------------- 内部 ----------------

  private rollDay() {
    const d = localDay();
    if (this.s.extraDay !== d) {
      this.s.extraDay = d;
      this.s.extraToday = 0;
    }
  }

  private goalOver(goalId: string) {
    const lim = this.s.budget.perGoal;
    return lim > 0 && (this.s.byGoal[goalId]?.cost ?? 0) >= lim + (this.s.extraGoal[goalId] ?? 0);
  }

  private release(goalId: string) {
    this.s.heldGoals = this.s.heldGoals.filter((g) => g !== goalId);
    store.onChangeNotify();
  }

  private pendingBudget(scope: 'daily' | 'goal', goalId?: string) {
    return [...store.approvals.values()].some((a) => a.status === 'pending' && a.budget?.scope === scope && (scope === 'daily' || a.budget.goalId === goalId));
  }

  private checkBudget(goalId: string | null) {
    const { daily } = this.s.budget;
    const spent = this.s.byDay[localDay()]?.cost ?? 0;
    if (daily > 0 && spent >= daily + this.s.extraToday && !this.pendingBudget('daily')) {
      store.globalPaused = true;
      bus.emit({ t: 'paused', d: true });
      store.createApproval({
        kind: 'question',
        taskId: null,
        requesterId: 'system',
        approver: 'human',
        risk: 'R2',
        budget: { scope: 'daily' },
        title: `今日花费 ${fmt(spent)} 已达每日预算，全公司已暂停`,
        detail: `每日预算 ${fmt(daily)}${this.s.extraToday ? `（今日已追加 ${fmt(this.s.extraToday)}）` : ''}，今日已花费 ${fmt(spent)}。\n同意 = 再追加 ${fmt(daily)} 今日额度并恢复工作；驳回 = 保持暂停。`,
      });
      bus.log('warn', `今日花费 ${fmt(spent)} 达到每日预算，全公司暂停，等待老板决定`);
    }
    if (goalId && this.goalOver(goalId) && !this.s.heldGoals.includes(goalId) && !this.pendingBudget('goal', goalId)) {
      this.s.heldGoals.push(goalId);
      const g = store.tasks.get(goalId);
      const cost = this.s.byGoal[goalId]?.cost ?? 0;
      store.createApproval({
        kind: 'question',
        taskId: goalId,
        requesterId: 'system',
        approver: 'human',
        risk: 'R2',
        budget: { scope: 'goal', goalId },
        title: `目标「${g?.title ?? goalId}」已花费 ${fmt(cost)}，超出单目标预算`,
        detail: `单目标预算 ${fmt(this.s.budget.perGoal)}${this.s.extraGoal[goalId] ? `（已追加 ${fmt(this.s.extraGoal[goalId])}）` : ''}，该目标已花费 ${fmt(cost)}。相关员工已暂停该目标的工作。\n同意 = 再追加 ${fmt(this.s.budget.perGoal)} 继续；驳回 = 取消这个目标。`,
      });
      bus.log('warn', `目标 ${goalId} 花费 ${fmt(cost)} 超出单目标预算，已暂停，等待老板决定`, null, goalId);
    }
  }

  private changed() {
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        bus.emit({ t: 'usage', d: this.stats() });
      }, 800);
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const days = Object.keys(this.s.byDay).sort();
      for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) {
        delete this.s.byDay[d];
        if (this.s.byDayAgent) delete this.s.byDayAgent[d];
      }
      db.setKv('usage', this.s);
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.s));
      fs.renameSync(tmp, FILE);
    }, 1000);
  }
}

function sum(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, cacheHit: a.cacheHit + b.cacheHit, output: a.output + b.output, cost: a.cost + b.cost, calls: a.calls + b.calls };
}

export function fmt(cost: number) {
  return `${config.pricing.currency}${cost.toFixed(cost < 1 ? 3 : 2)}`;
}

export const usage = new UsageLedger();
