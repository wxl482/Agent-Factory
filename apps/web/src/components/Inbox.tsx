import { useState } from 'react';
import { Button, Empty, Input, Segmented, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CheckOutlined, CloseCircleFilled, CloseOutlined, EditOutlined, FileDoneOutlined, LoadingOutlined } from '@ant-design/icons';
import type { Approval } from '@af/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { confirmAction } from '../lib/ui';
import { agentColor, agentName, fmtAgo } from './util';

const KIND: Record<Approval['kind'], string> = { tool: '操作审批', question: '请示决策', acceptance: '交付验收' };
const RISK_COLOR = { R0: 'green', R1: 'gold', R2: 'red' } as const;

type View = 'pending' | 'manager' | 'history';

export function Inbox() {
  const approvals = useStore((s) => s.approvals);
  const all = Object.values(approvals).sort((a, b) => b.createdAt - a.createdAt);
  const mine = all.filter((a) => a.status === 'pending' && a.approver === 'human');
  const mgr = all.filter((a) => a.status === 'pending' && a.approver === 'manager');
  const history = all.filter((a) => a.status !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  const [view, setView] = useState<View>('pending');

  return (
    <div className="inbox">
      <div className="panel-toolbar">
        <Segmented
          size="small"
          value={view}
          onChange={(v) => setView(v as View)}
          options={[
            { value: 'pending', label: `待处理 ${mine.length || ''}` },
            { value: 'manager', label: `经理处理中 ${mgr.length || ''}` },
            { value: 'history', label: '历史' },
          ]}
        />
      </div>

      {view === 'pending' && <BatchBar items={mine} />}
      {view === 'pending' &&
        (mine.length ? mine.map((a) => <ApprovalCard key={a.id} a={a} />) : <Empty className="empty-ant" image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂时没有需要你决策的事项" />)}

      {view === 'manager' &&
        (mgr.length ? (
          <div className="card-list">
            {mgr.map((a) => (
              <ManagerCard key={a.id} a={a} />
            ))}
          </div>
        ) : (
          <Empty className="empty-ant" image={Empty.PRESENTED_IMAGE_SIMPLE} description="经理手上没有待审批事项" />
        ))}

      {view === 'history' &&
        (history.length ? (
          <div className="card-list">
            {history.slice(0, 50).map((a) => (
              <HistoryCard key={a.id} a={a} />
            ))}
          </div>
        ) : (
          <Empty className="empty-ant" image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有决策记录" />
        ))}
    </div>
  );
}

/** 多个操作审批同时等着时，一键全部处理（请示和验收要逐条看，不参与批量） */
function BatchBar({ items }: { items: Approval[] }) {
  const tools = items.filter((a) => a.kind === 'tool');
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  if (tools.length < 2) return null;
  const run = async (approve: boolean) => {
    const r2 = tools.filter((a) => a.risk === 'R2').length;
    if (!(await confirmAction(`${approve ? '批准' : '驳回'}全部 ${tools.length} 个操作审批？`, r2 ? `其中 ${r2} 个是 R2 高风险操作，请确认已经看过。` : undefined))) return;
    setBusy(approve ? 'yes' : 'no');
    try {
      await api('/api/approvals/batch', { ids: tools.map((a) => a.id), approve });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="batch-bar">
      <span>{tools.length} 个操作审批待处理</span>
      <span className="spacer" />
      <Button size="small" danger loading={busy === 'no'} disabled={!!busy} onClick={() => run(false)}>
        全部驳回
      </Button>
      <Button size="small" type="primary" className="btn-ok" loading={busy === 'yes'} disabled={!!busy} onClick={() => run(true)}>
        全部批准
      </Button>
    </div>
  );
}

/** 按「公司规则」的超时设置，提示这条事项多久后会被自动处理 */
function TimeoutHint({ a }: { a: Approval }) {
  const t = useStore((s) => s.settings?.timeout);
  if (!t?.minutes || a.budget || a.kind === 'acceptance' || (a.kind === 'question' && t.questionAction === 'wait')) return null;
  const left = Math.max(0, Math.ceil((a.createdAt + t.minutes * 60_000 - Date.now()) / 60_000));
  return <span className="timeout-hint">{left} 分钟内未处理将{a.kind === 'tool' ? '自动驳回' : '授权经理自行判断'}</span>;
}

function ManagerCard({ a }: { a: Approval }) {
  return (
    <div className="approval-card is-mgr">
      <div className="ac-head">
        <Tag color={RISK_COLOR[a.risk]} bordered={false} className="mini-tag">
          {a.risk}
        </Tag>
        <span className="kind">{KIND[a.kind]}</span>
        <span className="from">
          <i style={{ background: agentColor(a.requesterId) }} />
          {agentName(a.requesterId)} · {fmtAgo(a.createdAt)}
        </span>
        {a.taskId && <span className="tid">{a.taskId}</span>}
      </div>
      <div className="ac-title">{a.title}</div>
      {a.detail && a.detail !== a.title && (
        <Typography.Paragraph className={`ac-detail ${a.kind === 'tool' ? 'mono' : ''}`} ellipsis={{ rows: 2, expandable: 'collapsible', symbol: (exp) => (exp ? '收起' : '展开') }}>
          {a.detail}
        </Typography.Paragraph>
      )}
      <div className="ac-foot-meta">
        <LoadingOutlined style={{ color: '#60a5fa' }} />
        <span>正在等待经理审批…</span>
      </div>
    </div>
  );
}

function HistoryCard({ a }: { a: Approval }) {
  const ok = a.status === 'approved';
  const who = a.decidedBy === 'human' ? '老板' : a.decidedBy === 'system' ? '系统' : agentName(a.decidedBy ?? '');
  const tasks = useStore((s) => s.tasks);
  const goalId = a.taskId ? (tasks[a.taskId]?.kind === 'goal' ? a.taskId : tasks[a.taskId]?.parentId) : null;

  return (
    <div className={`approval-card is-history ${ok ? 'is-ok' : 'is-no'}`}>
      <div className="ac-head">
        <Tag color={ok ? 'success' : 'error'} bordered={false} className="mini-tag">
          {ok ? '✓ 已通过' : '✕ 已驳回'}
        </Tag>
        <Tag color={RISK_COLOR[a.risk]} bordered={false} className="mini-tag">
          {a.risk}
        </Tag>
        <span className="kind">{KIND[a.kind]}</span>
        <span className="from">
          <i style={{ background: agentColor(a.requesterId) }} />
          {agentName(a.requesterId)}
        </span>
        {a.taskId && <span className="tid">{a.taskId}</span>}
      </div>
      <div className="ac-title">{a.title}</div>
      {a.detail && a.detail !== a.title && (
        <Typography.Paragraph className={`ac-detail ${a.kind === 'tool' ? 'mono' : ''}`} ellipsis={{ rows: 2, expandable: 'collapsible', symbol: (exp) => (exp ? '收起' : '展开') }}>
          {a.detail}
        </Typography.Paragraph>
      )}
      {a.comment && <div className="ac-quote">“{a.comment}”</div>}
      <div className="ac-foot-meta">
        {ok ? <CheckCircleFilled style={{ color: '#10b981' }} /> : <CloseCircleFilled style={{ color: '#ef4444' }} />}
        <span>
          由 <b>{who}</b> {a.autoDecided ? '（超时自动）' : ''}决定 · {fmtAgo(a.decidedAt ?? a.createdAt)}
        </span>
        {goalId && (
          <Button type="link" size="small" className="ac-link-btn" icon={<FileDoneOutlined />} onClick={() => useStore.setState({ deliveryGoal: goalId })}>
            交付页
          </Button>
        )}
      </div>
    </div>
  );
}

function ApprovalCard({ a }: { a: Approval }) {
  // 请示类需要老板给出口径，备注框默认展开；其他类型一键决定，需要时再加备注
  const [noteOpen, setNoteOpen] = useState(a.kind === 'question');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(approve ? 'yes' : 'no');
    try {
      await api(`/api/approvals/${a.id}`, { approve, comment });
    } finally {
      setBusy(null);
    }
  };
  const [yes, no] = a.kind === 'acceptance' ? ['验收通过', '打回'] : a.kind === 'question' ? ['同意', '否决'] : ['批准', '驳回'];

  return (
    <div className={`approval-card r-${a.risk}`}>
      <div className="ac-head">
        <Tag color={RISK_COLOR[a.risk]} bordered={false} className="mini-tag">
          {a.risk}
        </Tag>
        <span className="kind">{KIND[a.kind]}</span>
        <span className="from">
          <i style={{ background: agentColor(a.requesterId) }} />
          {agentName(a.requesterId)} · {fmtAgo(a.createdAt)}
        </span>
        {a.taskId && <span className="tid">{a.taskId}</span>}
      </div>
      <div className="ac-title">{a.title}</div>
      <TimeoutHint a={a} />
      {a.detail && a.detail !== a.title && (
        <Typography.Paragraph className={`ac-detail ${a.kind === 'tool' ? 'mono' : ''}`} ellipsis={{ rows: 4, expandable: 'collapsible', symbol: (exp) => (exp ? '收起' : '展开') }}>
          {a.detail}
        </Typography.Paragraph>
      )}
      {a.options && a.options.length > 0 && (
        <div className="ac-options">
          {a.options.map((o) => (
            <Tag.CheckableTag
              key={o}
              checked={comment === o}
              onChange={() => {
                setComment(o);
                setNoteOpen(true);
              }}
            >
              {o}
            </Tag.CheckableTag>
          ))}
        </div>
      )}
      {noteOpen && (
        <Input.TextArea
          className="ac-note"
          placeholder={a.kind === 'question' ? '你的答复 / 口径（会转达给 Agent）' : '备注 / 指导意见（会转达给 Agent）'}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 6 }}
        />
      )}
      <div className="ac-actions">
        {!noteOpen && (
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setNoteOpen(true)}>
            加备注
          </Button>
        )}
        {a.kind === 'acceptance' && a.taskId && (
          <Button type="text" size="small" icon={<FileDoneOutlined />} onClick={() => useStore.setState({ deliveryGoal: a.taskId })}>
            查看交付
          </Button>
        )}
        <span className="spacer" />
        <Button size="small" danger icon={<CloseOutlined />} loading={busy === 'no'} disabled={!!busy} onClick={() => decide(false)}>
          {no}
        </Button>
        <Button size="small" type="primary" className="btn-ok" icon={<CheckOutlined />} loading={busy === 'yes'} disabled={!!busy} onClick={() => decide(true)}>
          {yes}
        </Button>
      </div>
    </div>
  );
}
