import { useEffect, useState } from 'react';
import { Alert, Button, InputNumber, Modal, Progress, Segmented, Tooltip } from 'antd';
import type { Usage, UsageStats } from '@af/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { agentColor, agentName, fmtCost, fmtTokens } from './util';

/** 顶栏的花费入口：今日花费 + 预算进度，点开看明细 */
export function CostChip() {
  const usage = useStore((s) => s.usage);
  if (!usage) return null;
  const today = usage.byDay[usage.today]?.cost ?? 0;
  const limit = usage.budget.daily ? usage.budget.daily + usage.extraToday : 0;
  const pct = limit ? Math.min(100, (today / limit) * 100) : 0;
  return (
    <Tooltip title={limit ? `今日 ${fmtCost(today)} / 预算 ${fmtCost(limit)}，点开看明细` : '今日花费（未设每日预算），点开看明细与设置预算'}>
      <button className={`cost-chip ${pct >= 100 ? 'over' : pct >= 80 ? 'near' : ''}`} onClick={() => useStore.setState({ showCost: true })}>
        <span>💰 今日 {fmtCost(today)}</span>
        {limit > 0 && (
          <span className="cost-chip-bar">
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
      </button>
    </Tooltip>
  );
}

type Range = 'today' | '7d' | 'all';

export function CostModal() {
  const show = useStore((s) => s.showCost);
  const usage = useStore((s) => s.usage);
  const close = () => useStore.setState({ showCost: false });
  return (
    <Modal open={show} onCancel={close} footer={null} width={760} title="成本与预算" destroyOnHidden>
      {usage ? <CostBody u={usage} /> : null}
    </Modal>
  );
}

function CostBody({ u }: { u: UsageStats }) {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.profile?.agents ?? []);
  const [range, setRange] = useState<Range>('today');
  const today = u.byDay[u.today];
  const days = lastDays(u.today, 14);
  const week = days.slice(-7).reduce((s, d) => s + (u.byDay[d]?.cost ?? 0), 0);
  const dailyLimit = u.budget.daily ? u.budget.daily + u.extraToday : 0;

  // 分员工：支持按时间段（今日 / 近 7 天 / 累计）聚合
  const agentUsageForRange = (agentId: string): Usage | undefined => {
    if (range === 'all' || !u.byDayAgent) return u.byAgent[agentId];
    const targetDays = range === 'today' ? [u.today] : days.slice(-7);
    const s: Usage = { input: 0, cacheHit: 0, output: 0, cost: 0, calls: 0 };
    for (const d of targetDays) {
      const x = u.byDayAgent[d]?.[agentId];
      if (!x) continue;
      s.input += x.input;
      s.cacheHit += x.cacheHit;
      s.output += x.output;
      s.cost += x.cost;
      s.calls += x.calls;
    }
    return s.calls ? s : u.byAgent[agentId];
  };
  const byAgent = agents
    .map((a) => ({ id: a.id, u: agentUsageForRange(a.id) }))
    .filter((x) => x.u?.calls)
    .sort((a, b) => b.u!.cost - a.u!.cost);
  const byModel = Object.entries(u.byModel ?? {})
    .filter(([, m]) => m.calls > 0)
    .sort((a, b) => b[1].cost - a[1].cost);
  const goals = Object.entries(u.byGoal)
    .map(([id, g]) => ({ id, g, t: tasks[id] }))
    .sort((a, b) => b.g.cost - a.g.cost)
    .slice(0, 12);
  const maxDay = Math.max(1e-9, ...days.map((d) => u.byDay[d]?.cost ?? 0));
  const rangeUsage = range === 'today' ? today : range === '7d' ? sumDays(u, days.slice(-7)) : u.total;

  return (
    <div className="cost-body">
      {u.simulated && <Alert type="warning" showIcon message="演示模式：token 是按文本长度估算的，花费仅供参考。接入真实模型后按服务商返回的用量计费。" className="cost-alert" />}

      <div className="dl-stats">
        <div className={`dl-stat ${dailyLimit && (today?.cost ?? 0) >= dailyLimit ? 'warn' : ''}`}>
          <div className="dl-stat-label">今日</div>
          <div className="dl-stat-value">{fmtCost(today?.cost)}</div>
          {dailyLimit > 0 ? (
            <Progress percent={Math.min(100, ((today?.cost ?? 0) / dailyLimit) * 100)} size="small" showInfo={false} status={(today?.cost ?? 0) >= dailyLimit ? 'exception' : 'normal'} />
          ) : (
            <div className="dl-stat-sub">未设每日预算</div>
          )}
        </div>
        <div className="dl-stat">
          <div className="dl-stat-label">近 7 天</div>
          <div className="dl-stat-value">{fmtCost(week)}</div>
          <div className="dl-stat-sub">日均 {fmtCost(week / 7)}</div>
        </div>
        <div className="dl-stat">
          <div className="dl-stat-label">累计</div>
          <div className="dl-stat-value">{fmtCost(u.total.cost)}</div>
          <div className="dl-stat-sub">{u.total.calls} 次调用</div>
        </div>
        <div className="dl-stat">
          <div className="dl-stat-label">缓存命中</div>
          <div className="dl-stat-value">{u.total.input ? Math.round((u.total.cacheHit / u.total.input) * 100) : 0}%</div>
          <div className="dl-stat-sub">命中部分按 {u.pricing.currency}{u.pricing.cacheHit}/M 计</div>
        </div>
      </div>

      <h4 className="cost-h">近 14 天</h4>
      <div className="cost-days">
        {days.map((d) => {
          const c = u.byDay[d]?.cost ?? 0;
          return (
            <Tooltip key={d} title={`${d}：${fmtCost(c)} · ${u.byDay[d]?.calls ?? 0} 次调用`}>
              <div className={`cost-day ${d === u.today ? 'is-today' : ''}`}>
                <div className="cost-day-bar" style={{ height: `${Math.max(c ? 4 : 0, (c / maxDay) * 100)}%` }} />
                <span>{d.slice(8)}</span>
              </div>
            </Tooltip>
          );
        })}
      </div>

      <div className="cost-split">
        <div>
          <h4 className="cost-h">按员工（{range === 'today' ? '今日' : range === '7d' ? '近 7 天' : '累计'}）</h4>
          {byAgent.length ? (
            byAgent.map(({ id, u: a }) => <Bar key={id} label={agentName(id)} color={agentColor(id)} u={a!} max={byAgent[0].u!.cost} />)
          ) : (
            <div className="dl-empty">还没有调用</div>
          )}
          {byModel.length > 0 && (
            <>
              <h4 className="cost-h" style={{ marginTop: 14 }}>按模型（累计）</h4>
              {byModel.map(([m, mu]) => (
                <Bar key={m} label={`${m} (${mu.calls}次)`} color="#6366f1" u={mu} max={byModel[0][1].cost} />
              ))}
            </>
          )}
        </div>
        <div>
          <h4 className="cost-h">按目标（累计，点击看交付页）</h4>
          {goals.length ? (
            goals.map(({ id, g, t }) => (
              <Bar key={id} label={t?.title ?? id} u={g} max={goals[0].g.cost} onClick={t ? () => useStore.setState({ deliveryGoal: id, showCost: false }) : undefined} held={u.heldGoals.includes(id)} />
            ))
          ) : (
            <div className="dl-empty">还没有目标产生花费</div>
          )}
        </div>
      </div>

      <div className="cost-range">
        <Segmented
          size="small"
          value={range}
          onChange={(v) => setRange(v as Range)}
          options={[
            { value: 'today', label: '今日' },
            { value: '7d', label: '近 7 天' },
            { value: 'all', label: '累计' },
          ]}
        />
        <span>
          输入 {fmtTokens(rangeUsage?.input ?? 0)}（缓存 {fmtTokens(rangeUsage?.cacheHit ?? 0)}）· 输出 {fmtTokens(rangeUsage?.output ?? 0)} · {rangeUsage?.calls ?? 0} 次调用
        </span>
      </div>

      <BudgetForm u={u} />
    </div>
  );
}

function Bar({ label, color, u, max, onClick, held }: { label: string; color?: string; u: Usage; max: number; onClick?: () => void; held?: boolean }) {
  return (
    <div className={`cost-bar ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="cost-bar-top">
        <span className="cost-bar-label">
          {color && <i style={{ background: color }} />}
          {label}
          {held && <span className="cost-held">超预算暂停</span>}
        </span>
        <span className="cost-bar-val">{fmtCost(u.cost)}</span>
      </div>
      <div className="cost-bar-track">
        <div style={{ width: `${max ? (u.cost / max) * 100 : 0}%`, background: color ?? '#f59e0b' }} />
      </div>
    </div>
  );
}

function BudgetForm({ u }: { u: UsageStats }) {
  const [daily, setDaily] = useState<number | null>(u.budget.daily || null);
  const [perGoal, setPerGoal] = useState<number | null>(u.budget.perGoal || null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDaily(u.budget.daily || null);
    setPerGoal(u.budget.perGoal || null);
  }, [u.budget.daily, u.budget.perGoal]);
  const dirty = (daily ?? 0) !== u.budget.daily || (perGoal ?? 0) !== u.budget.perGoal;
  const save = async () => {
    setSaving(true);
    try {
      await api('/api/budget', { daily: daily ?? 0, perGoal: perGoal ?? 0 });
    } finally {
      setSaving(false);
    }
  };
  const cur = u.pricing.currency;
  return (
    <div className="budget-form">
      <h4 className="cost-h">预算（留空 = 不限）</h4>
      <div className="budget-row">
        <label>
          每日预算
          <InputNumber min={0} step={1} prefix={cur} placeholder="不限" value={daily} onChange={(v) => setDaily(v)} />
        </label>
        <label>
          单目标预算
          <InputNumber min={0} step={1} prefix={cur} placeholder="不限" value={perGoal} onChange={(v) => setPerGoal(v)} />
        </label>
        <Button type="primary" disabled={!dirty} loading={saving} onClick={save}>
          保存
        </Button>
      </div>
      <div className="budget-hint">
        超出每日预算：全公司自动暂停，并请示你是否追加今日额度。超出单目标预算：该目标暂停，请示你追加或取消。单价：输入 {cur}
        {u.pricing.input}/M · 缓存命中 {cur}
        {u.pricing.cacheHit}/M · 输出 {cur}
        {u.pricing.output}/M（在 .env 用 LLM_PRICE_* 修改）。
      </div>
    </div>
  );
}

function lastDays(today: string, n: number) {
  const [y, m, d] = today.split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(y, m - 1, d - i);
    out.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`);
  }
  return out;
}

function sumDays(u: UsageStats, days: string[]): Usage {
  const s: Usage = { input: 0, cacheHit: 0, output: 0, cost: 0, calls: 0 };
  for (const d of days) {
    const x = u.byDay[d];
    if (!x) continue;
    s.input += x.input;
    s.cacheHit += x.cacheHit;
    s.output += x.output;
    s.cost += x.cost;
    s.calls += x.calls;
  }
  return s;
}
