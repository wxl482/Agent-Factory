import { useState } from 'react';
import { Button, Dropdown, Empty, Progress, Segmented, Tag, Tooltip, Typography, type MenuProps } from 'antd';
import { DownOutlined, FileDoneOutlined, MoreOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import type { Priority, RoleDef, Task, TaskStatus, UsageStats } from '@af/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { confirmAction } from '../lib/ui';
import { agentColor, agentName, fmtAgo, fmtCost, fmtDuration, NONE, PRIORITY_COLOR, STATUS_CN } from './util';

type View = 'active' | 'done' | 'all';

const STATUS_COLOR: Record<TaskStatus, string> = {
  planning: 'gold',
  todo: 'default',
  in_progress: 'processing',
  review: 'purple',
  changes_requested: 'orange',
  blocked: 'orange',
  awaiting_human: 'red',
  done: 'success',
  cancelled: 'default',
};
const DOT_COLOR: Record<TaskStatus, string> = {
  planning: '#f59e0b',
  todo: '#64748b',
  in_progress: '#3b82f6',
  review: '#a855f7',
  changes_requested: '#f97316',
  blocked: '#f97316',
  awaiting_human: '#ef4444',
  done: '#10b981',
  cancelled: '#475569',
};
const finished = (t: Task) => t.status === 'done' || t.status === 'cancelled';

export function TaskBoard() {
  const tasks = useStore((s) => s.tasks);
  const roles = useStore((s) => s.profile?.roles ?? NONE);
  const usage = useStore((s) => s.usage);
  const [view, setView] = useState<View>('active');
  const all = Object.values(tasks);
  const goalsAll = all.filter((t) => t.kind === 'goal');
  const active = goalsAll.filter((g) => !finished(g));
  const goals = (view === 'active' ? active : view === 'done' ? goalsAll.filter(finished) : goalsAll).sort(
    (a, b) => Number(finished(a)) - Number(finished(b)) || a.priority.localeCompare(b.priority) || b.createdAt - a.createdAt,
  );

  return (
    <div className="taskboard">
      <div className="panel-toolbar">
        <Segmented
          size="small"
          value={view}
          onChange={(v) => setView(v as View)}
          options={[
            { value: 'active', label: `进行中 ${active.length || ''}` },
            { value: 'done', label: '已完成' },
            { value: 'all', label: '全部' },
          ]}
        />
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => useStore.setState({ showNewGoal: true })}>
          新目标
        </Button>
      </div>
      {goals.length === 0 && (
        <Empty className="empty-ant" image={Empty.PRESENTED_IMAGE_SIMPLE} description={view === 'active' ? '没有进行中的目标，点「新目标」给公司派活吧' : '暂无'} />
      )}
      <div className="card-list">
        {goals.map((g) => {
          const kids = all.filter((t) => t.parentId === g.id).sort((a, b) => a.createdAt - b.createdAt);
          return <GoalCard key={g.id} g={g} kids={kids} roles={roles} usage={usage} />;
        })}
      </div>
    </div>
  );
}

function GoalCard({ g, kids, roles, usage }: { g: Task; kids: Task[]; roles: RoleDef[]; usage: UsageStats | null }) {
  const done = kids.filter((k) => k.status === 'done').length;
  const pct = kids.length ? Math.round((done / kids.length) * 100) : 0;
  const open = () => useStore.setState({ deliveryGoal: g.id });
  const held = usage?.heldGoals.includes(g.id);
  const cost = usage?.byGoal[g.id];
  const artifactCount = new Set([g, ...kids].flatMap((t) => t.artifacts).filter((p) => !/^\.tmp/i.test(p))).size;

  return (
    <div className={`goal-card st-${g.status} ${finished(g) ? 'is-finished' : ''}`} style={{ borderLeftColor: DOT_COLOR[g.status] }}>
      <div className="goal-head">
        <span className="prio-badge" style={{ color: PRIORITY_COLOR[g.priority], borderColor: `${PRIORITY_COLOR[g.priority]}44`, background: `${PRIORITY_COLOR[g.priority]}14` }}>
          {g.priority}
        </span>
        <Tooltip title="点击打开交付页" placement="topLeft" mouseEnterDelay={0.5}>
          <span className="goal-title clickable" onClick={open}>
            {g.title}
          </span>
        </Tooltip>
        <Tag color={STATUS_COLOR[g.status]} bordered={false} className="mini-tag">
          {STATUS_CN[g.status]}
        </Tag>
        <TaskMenu t={g} />
      </div>

      <div className="goal-chips">
        <span className="tid">{g.id}</span>
        <span>🕒 {fmtAgo(g.createdAt)}</span>
        <span>📋 {kids.length ? `${done}/${kids.length} 子任务` : '规划中'}</span>
        <span>💰 {fmtCost(cost?.cost)}</span>
        {artifactCount > 0 && <span>📄 {artifactCount} 个产出</span>}
        {held && <span className="cost-held">超预算暂停</span>}
        <Button type="link" size="small" className="goal-open-btn" icon={<FileDoneOutlined />} onClick={open}>
          交付详情
        </Button>
      </div>

      {kids.length > 0 && <Progress percent={pct} size="small" showInfo={false} strokeColor={DOT_COLOR[g.status] === '#475569' ? '#475569' : '#10b981'} className="goal-progress" />}

      {g.description && (
        <Typography.Paragraph className="goal-desc" ellipsis={{ rows: 2, expandable: 'collapsible', symbol: (e) => (e ? '收起' : '展开') }}>
          {g.description}
        </Typography.Paragraph>
      )}

      {kids.length > 0 && (
        <div className="subtask-cards">
          {kids.map((k) => (
            <SubtaskCard key={k.id} k={k} goalPriority={g.priority} roles={roles} usage={usage} />
          ))}
        </div>
      )}

      {g.result && g.status !== 'planning' && (
        <div className="goal-result" onClick={open} style={{ cursor: 'pointer' }}>
          <div className="goal-result-head">
            <span>✨ 交付总结</span>
            <small>点击查看完整产出 →</small>
          </div>
          <Typography.Paragraph ellipsis={{ rows: 2 }}>{g.result}</Typography.Paragraph>
        </div>
      )}
    </div>
  );
}

function SubtaskCard({ k, goalPriority, roles, usage }: { k: Task; goalPriority: Priority; roles: RoleDef[]; usage: UsageStats | null }) {
  const [expanded, setExpanded] = useState(false);
  const whoName = k.assigneeAgentId ? agentName(k.assigneeAgentId) : roles.find((r) => r.id === k.assigneeRoleId)?.name;
  const whoColor = k.assigneeAgentId ? agentColor(k.assigneeAgentId) : '#64748b';
  const taskCost = usage?.byTask[k.id]?.cost;
  const dur = k.startedAt ? fmtDuration((k.finishedAt ?? Date.now()) - k.startedAt) : null;

  return (
    <div className={`st-card ${finished(k) ? 'is-finished' : ''} ${expanded ? 'is-open' : ''}`}>
      <div className="st-card-top" onClick={() => setExpanded((v) => !v)}>
        <span className="st-expand-icon">{expanded ? <DownOutlined /> : <RightOutlined />}</span>
        <i className={`st-dot ${k.status === 'in_progress' ? 'pulse' : ''}`} style={{ background: DOT_COLOR[k.status] }} />
        <span className="st-title">{k.title}</span>
        {k.priority !== goalPriority && (
          <span className="prio small" style={{ color: PRIORITY_COLOR[k.priority] }}>
            {k.priority}
          </span>
        )}
        {k.reviewRounds > 0 && (
          <Tooltip title={`已返工 ${k.reviewRounds} 次`}>
            <span className="rework">↻{k.reviewRounds}</span>
          </Tooltip>
        )}
        <Tag color={STATUS_COLOR[k.status]} bordered={false} className="mini-tag st-status-tag">
          {STATUS_CN[k.status]}
        </Tag>
        <div onClick={(e) => e.stopPropagation()}>
          <TaskMenu t={k} hover />
        </div>
      </div>

      <div className="st-card-meta" onClick={() => setExpanded((v) => !v)}>
        {whoName && (
          <span className="st-who-chip">
            <i style={{ background: whoColor }} />
            {whoName}
          </span>
        )}
        <span className="tid">{k.id}</span>
        {dur && <span>⏱ {dur}</span>}
        {taskCost ? <span>{fmtCost(taskCost)}</span> : null}
        {k.artifacts.length > 0 && <span>📄 {k.artifacts.length} 文件</span>}
      </div>

      {expanded && (
        <div className="st-card-body">
          {k.description && (
            <div className="st-detail-block">
              <b>要求：</b>
              <span>{k.description}</span>
            </div>
          )}
          {k.acceptance && (
            <div className="st-detail-block acc">
              <b>验收标准：</b>
              <span>{k.acceptance}</span>
            </div>
          )}
          {k.result && (
            <div className="st-detail-block res">
              <b>完成情况：</b>
              <span>{k.result}</span>
            </div>
          )}
          {k.feedback && (
            <div className="st-detail-block fb">
              <b>评审反馈：</b>
              <span>{k.feedback}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 不常用的操作收进“…”菜单：调整优先级、取消 */
function TaskMenu({ t, hover }: { t: Task; hover?: boolean }) {
  if (finished(t)) return null;
  const items: MenuProps['items'] = [
    {
      key: 'prio',
      label: '调整优先级',
      children: (['P0', 'P1', 'P2', 'P3'] as Priority[]).map((p) => ({
        key: `prio-${p}`,
        disabled: p === t.priority,
        label: <span style={{ color: PRIORITY_COLOR[p], fontWeight: 700 }}>{p}</span>,
      })),
    },
    { type: 'divider' },
    { key: 'cancel', label: t.kind === 'goal' ? '取消目标' : '取消任务', danger: true },
  ];
  const onClick: MenuProps['onClick'] = async ({ key }) => {
    if (key.startsWith('prio-')) api(`/api/tasks/${t.id}/priority`, { priority: key.slice(5) });
    if (key === 'cancel' && (await confirmAction(`取消 ${t.id}？`, t.title))) api(`/api/tasks/${t.id}/cancel`, {});
  };
  return (
    <Dropdown menu={{ items, onClick }} trigger={['click']} placement="bottomRight">
      <Button type="text" size="small" className={`more-btn ${hover ? 'on-hover' : ''}`} icon={<MoreOutlined />} />
    </Dropdown>
  );
}
