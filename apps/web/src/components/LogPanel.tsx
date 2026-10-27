import { memo, useLayoutEffect, useRef, useState } from 'react';
import { Button, Empty, Input, Segmented, Select } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { LogEntry } from '@af/shared';
import { useStore } from '../lib/store';
import { agentColor, agentName, fmtTime, NONE } from './util';

type Filter = 'all' | 'key' | 'talk';
type Kind = 'tool' | 'talk' | 'thought' | 'event' | 'debug';

const TOOL_LABEL: Record<string, [string, string]> = {
  run_command: ['⌨️', '终端'],
  terminal_input: ['⌨️', '终端输入'],
  write_file: ['📝', '写文件'],
  edit_file: ['✏️', '改文件'],
  read_file: ['👀', '读文件'],
  list_files: ['📁', '看目录'],
  browser_open: ['🌐', '打开网页'],
  browser_read: ['🌐', '读网页'],
  browser_click: ['🖱', '点击'],
  browser_type: ['⌨️', '输入'],
  browser_back: ['🌐', '后退'],
  submit_for_review: ['✅', '提交评审'],
  report_blocked: ['⛔', '上报受阻'],
  reject_assignment: ['↩️', '退单'],
  ask_manager: ['🙋', '请示经理'],
  ask_colleague: ['🙋', '请教同事'],
  create_subtask: ['📋', '派单'],
  reassign_task: ['🔁', '改派'],
  call_meeting: ['📅', '召集会议'],
  talk_to: ['🗨️', '谈话'],
  approve_task: ['👍', '评审通过'],
  request_changes: ['👎', '打回'],
  decide_approval: ['🛂', '审批'],
  escalate_to_human: ['📣', '请示老板'],
  finalize_goal: ['🎯', '交付'],
  list_tasks: ['📋', '查看任务'],
  cancel_task: ['🗑', '取消任务'],
};

function kindOf(l: LogEntry): Kind {
  if (l.text.startsWith('🔧')) return 'tool';
  // Agent 自己的旁白（调用工具前说的一句话），不是和别人的对话
  if (l.level === 'debug' && l.text.startsWith('💬')) return 'thought';
  if (/^(💬|🗣|📅)/.test(l.text)) return 'talk';
  if (l.level === 'debug') return 'debug';
  return 'event';
}

function visible(l: LogEntry, f: Filter) {
  const k = kindOf(l);
  if (f === 'talk') return k === 'talk';
  if (f === 'key') return k === 'event' || k === 'talk' || l.level === 'warn' || l.level === 'error';
  return k !== 'debug';
}

export function LogPanel({ agentId }: { agentId?: string }) {
  const logs = useStore((s) => s.logs);
  const agents = useStore((s) => s.profile?.agents ?? NONE);
  const [who, setWho] = useState(agentId ?? 'all');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = logs.filter(
    (l) => visible(l, filter) && (who === 'all' || l.agentId === who || (who === 'system' && !l.agentId)) && (!q || l.text.includes(q) || l.taskId?.includes(q)),
  );
  const view = shown.slice(-500);

  useLayoutEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [view.length, view[view.length - 1]?.id]);

  return (
    <div className="logpanel">
      <div className="log-filters">
        <Segmented
          size="small"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          options={[
            { value: 'all', label: '全部' },
            { value: 'key', label: '关键事件' },
            { value: 'talk', label: '对话会议' },
          ]}
        />
        {!agentId && (
          <>
            <Select
              size="small"
              className="log-who-select"
              value={who}
              onChange={setWho}
              popupMatchSelectWidth={false}
              options={[
                { value: 'all', label: '所有人' },
                { value: 'system', label: '系统 / 老板' },
                ...agents.map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
            <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="搜索 / 任务号" value={q} onChange={(e) => setQ(e.target.value)} />
          </>
        )}
      </div>
      <div
        className="log-lines"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {view.map((l, i) => {
          const prev = view[i - 1];
          // 同一个人一分钟内的连续日志合成一组，不重复显示名字
          const cont = !!prev && prev.agentId === l.agentId && l.ts - prev.ts < 60_000;
          return <LogRow key={l.id} l={l} cont={cont} showTask={!cont || prev?.taskId !== l.taskId} />;
        })}
        {view.length === 0 && <Empty className="empty-ant" image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无日志" />}
      </div>
    </div>
  );
}

const LogRow = memo(function LogRow({ l, cont, showTask }: { l: LogEntry; cont: boolean; showTask: boolean }) {
  const [open, setOpen] = useState(false);
  const kind = kindOf(l);
  const color = l.agentId ? agentColor(l.agentId) : '#94a3b8';
  return (
    <div className={`log-row lv-${l.level} k-${kind} ${cont ? 'cont' : ''}`}>
      <span className="ts">{fmtTime(l.ts)}</span>
      <div className="log-main">
        {!cont && (
          <div className="log-who">
            <i style={{ background: color }} />
            <b style={{ color }}>{l.agentId ? agentName(l.agentId) : '系统'}</b>
            {showTask && l.taskId && <span className="tid">{l.taskId}</span>}
          </div>
        )}
        {cont && showTask && l.taskId && <span className="tid">{l.taskId}</span>}
        <LogContent l={l} kind={kind} open={open} toggle={() => setOpen((o) => !o)} />
      </div>
    </div>
  );
});

function LogContent({ l, kind, open, toggle }: { l: LogEntry; kind: Kind; open: boolean; toggle: () => void }) {
  if (kind === 'tool') {
    const m = /^🔧 (\w+) ?([\s\S]*)$/.exec(l.text);
    const name = m?.[1] ?? '';
    const arg = (m?.[2] ?? '').trim();
    const [icon, label] = TOOL_LABEL[name] ?? ['🔧', name];
    const firstLine = arg.split('\n')[0];
    const long = arg.includes('\n') || arg.length > 90;
    return (
      <div className="log-tool">
        <div className={`tool-head ${long ? 'clickable' : ''}`} onClick={long ? toggle : undefined}>
          <span className="tool-tag">
            {icon} {label}
          </span>
          {arg && !open && <code className="tool-arg">{firstLine.length > 90 ? firstLine.slice(0, 90) + '…' : firstLine}</code>}
          {long && (
            <Button type="link" size="small" className="more">
              {open ? '收起' : `展开${arg.includes('\n') ? ` · ${arg.split('\n').length} 行` : ''}`}
            </Button>
          )}
        </div>
        {open && <pre className="tool-full">{arg}</pre>}
      </div>
    );
  }

  if (kind === 'thought') {
    return <div className="log-thought">{l.text.replace(/^💬\s*/, '')}</div>;
  }

  if (kind === 'talk') {
    // “💬 → 老周：xxx” / “🗣 xxx” / “📅 召集会议…”
    const m = /^(💬|🗣|📅)\s*(?:→\s*([^：]+)：)?([\s\S]*)$/.exec(l.text);
    const icon = m?.[1] ?? '💬';
    const to = m?.[2];
    const body = (m?.[3] ?? l.text).trim();
    const long = body.length > 120 || body.split('\n').length > 3;
    return (
      <div className={`log-talk ${icon === '📅' ? 'meeting' : ''}`}>
        {to && <span className="talk-to">对 {to} 说</span>}
        {icon === '🗣' && <span className="talk-to">会议发言</span>}
        <div className={`talk-body ${long && !open ? 'clamp' : ''}`}>{icon === '📅' ? `📅 ${body}` : body}</div>
        {long && (
          <Button type="link" size="small" className="more" onClick={toggle}>
            {open ? '收起' : '展开全文'}
          </Button>
        )}
      </div>
    );
  }

  const long = l.text.length > 160 || l.text.split('\n').length > 3;
  return (
    <div className="log-text">
      <div className={`txt ${long && !open ? 'clamp' : ''}`}>{l.text}</div>
      {long && (
        <Button type="link" size="small" className="more" onClick={toggle}>
          {open ? '收起' : '展开'}
        </Button>
      )}
    </div>
  );
}
