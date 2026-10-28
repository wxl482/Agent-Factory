import { useEffect, useState } from 'react';
import { Badge, Button, Descriptions, Input, Modal, Segmented, Select, Space, Switch, Tag, Tooltip } from 'antd';
import { CloseOutlined, ControlOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import type { GoalTemplate, Priority, ScreenMode } from '@af/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { confirmAction } from '../lib/ui';
import { CostChip } from './CostPanel';
import { LogPanel } from './LogPanel';
import { Screen } from './Screen';
import { PRIORITY_COLOR, STATUS_CN } from './util';

export function TopBar() {
  const { profile, profiles, llm, connected, globalPaused, agents } = useStore();
  const list = Object.values(agents);
  const busy = list.filter((a) => a.status === 'working' || a.status === 'thinking').length;
  return (
    <header className="topbar">
      <div className="logo">
        <span className="logo-mark" />
        AGENT<b>FACTORY</b>
      </div>
      <Tooltip title={profile?.description} placement="bottomLeft">
        <Select
          className="profile-select"
          value={profile?.id}
          popupMatchSelectWidth={false}
          options={profiles.map((p) => ({ value: p.id, label: `🏢 ${p.name}` }))}
          onChange={async (id) => {
            if (await confirmAction('切换公司业务配置？', '所有员工会被重新安排，需要先等大家手头的工作结束。')) api('/api/profile', { id });
          }}
        />
      </Tooltip>
      <Space size={18} className="stats">
        <Tooltip title="在岗工作 / 总人数">
          <span>👷 {busy}/{list.length}</span>
        </Tooltip>
        <CostChip />
        <Tooltip title={llm?.provider === 'mock' ? '演示模式：不调用真实模型。点击接入真实模型' : '当前模型，点击修改'}>
          <Tag color={llm?.provider === 'mock' ? 'gold' : 'default'} bordered={false} className="model-tag" onClick={() => useStore.setState({ showModel: true })}>
            🧠 {llm?.model}
          </Tag>
        </Tooltip>
        <Badge status={connected ? 'success' : 'error'} text={connected ? '在线' : '重连中'} />
      </Space>
      <Space>
        <Tooltip title="公司规则：审批权限、超时处理、消息推送">
          <Button icon={<ControlOutlined />} onClick={() => useStore.setState({ showRules: true })}>
            规则
          </Button>
        </Tooltip>
        <Button
          className="topbar-pause"
          danger={!globalPaused}
          type={globalPaused ? 'default' : 'primary'}
          icon={globalPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
          onClick={() => api('/api/pause', { paused: !globalPaused })}
        >
          {globalPaused ? '全员复工' : '全员暂停'}
        </Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => useStore.setState({ showNewGoal: true, goalDraft: null })}>
          下达目标
        </Button>
      </Space>
    </header>
  );
}

const PRIORITY_HINT: Record<Priority, string> = { P0: '紧急·可抢占', P1: '重要', P2: '常规', P3: '有空再做' };

/** 没有在公司配置里写模板时的通用模板 */
const DEFAULT_TEMPLATES: GoalTemplate[] = [
  { icon: '📕', label: '写文案', title: '写一篇【平台】文案，介绍【产品/活动】', description: '介绍对象：【是什么】\n核心卖点：【1~3 个】\n目标人群：【谁】\n语气风格：【例如：活泼真实】\n交付：【例如：3 个标题备选 + 正文】' },
  { icon: '🔍', label: '做调研', title: '调研【主题】', description: '调研对象：【是什么】\n关注维度：【例如：价格、功能、口碑】\n交付：一份调研报告（含结论和建议）' },
  { icon: '🛠', label: '做工具', title: '做一个【用途】小工具', description: '用途：【解决什么问题】\n输入：【用户提供什么】\n输出：【得到什么】\n交付：可直接使用的工具 + 使用说明' },
];

export function goalTemplates(): GoalTemplate[] {
  const t = useStore.getState().profile?.goalTemplates;
  return t?.length ? t : DEFAULT_TEMPLATES;
}

/** 打开「下达目标」并预填模板 */
export function openGoalWith(t?: GoalTemplate) {
  useStore.setState({ showNewGoal: true, goalDraft: t ? { title: t.title, description: t.description, priority: t.priority } : null });
}

export function NewGoalDialog() {
  const show = useStore((s) => s.showNewGoal);
  const draft = useStore((s) => s.goalDraft);
  const profile = useStore((s) => s.profile);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [prio, setPrio] = useState<Priority>('P2');
  const [clarify, setClarify] = useState(false);
  const [loading, setLoading] = useState(false);
  const templates = profile?.goalTemplates?.length ? profile.goalTemplates : DEFAULT_TEMPLATES;
  // 每次打开时按草稿（模板）初始化
  useEffect(() => {
    if (!show) return;
    setTitle(draft?.title ?? '');
    setDesc(draft?.description ?? '');
    setPrio(draft?.priority ?? 'P2');
  }, [show, draft]);
  const hasPlaceholder = /【[^】]*】/.test(title + desc);
  const close = () => useStore.setState({ showNewGoal: false, goalDraft: null });
  const submit = async () => {
    if (!title.trim()) return;
    if (hasPlaceholder && !(await confirmAction('还有【】里的内容没改', '【】是模板里需要换成你自己内容的地方。不改也可以下达，团队会按自己的理解补全。'))) return;
    setLoading(true);
    try {
      await api('/api/goals', { title, description: desc, priority: prio, clarify });
      setTitle('');
      setDesc('');
      setClarify(false);
      close();
      useStore.setState({ tab: 'tasks', sideCollapsed: false });
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal
      open={show}
      title="📋 给公司下达新目标"
      okText="下达"
      cancelText="取消"
      onOk={submit}
      onCancel={close}
      okButtonProps={{ disabled: !title.trim(), loading }}
      destroyOnHidden
      width={560}
    >
      <div className="form-col">
        <label>从模板开始（可选）</label>
        <div className="goal-templates">
          {templates.map((t) => (
            <button
              key={t.label}
              type="button"
              className="goal-tpl"
              onClick={() => {
                setTitle(t.title);
                setDesc(t.description);
                if (t.priority) setPrio(t.priority);
              }}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
        <label>目标</label>
        <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清楚要什么，例如：写一篇小红书笔记介绍我们的新咖啡店" onPressEnter={submit} />
        <label>详细说明（越具体，交付越贴近你的想法；【】里是需要换成你自己内容的地方）</label>
        <Input.TextArea rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="写清楚：给谁看、要包含什么、什么风格、交付成什么形式" />
        <label>优先级</label>
        <Segmented
          block
          className="prio-seg"
          value={prio}
          onChange={(v) => setPrio(v as Priority)}
          options={(['P0', 'P1', 'P2', 'P3'] as Priority[]).map((p) => ({
            value: p,
            label: (
              <div className="prio-opt">
                <b style={{ color: PRIORITY_COLOR[p] }}>{p}</b>
                <small>{PRIORITY_HINT[p]}</small>
              </div>
            ),
          }))}
        />
        <div className="goal-clarify">
          <Switch size="small" checked={clarify} onChange={setClarify} />
          <div>
            <b>先问清楚再开工</b>
            <span>经理会先向你确认 1~3 个关键问题（受众、风格、范围等），答完再派活。想法还比较模糊时推荐打开</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

const AGENT_STATUS_CN = { idle: '空闲', thinking: '思考中', working: '工作中', waiting: '等待审批', paused: '已暂停', error: '出错' } as const;

const MODES: { value: ScreenMode | 'live'; label: string }[] = [
  { value: 'live', label: '实时' },
  { value: 'terminal', label: '终端' },
  { value: 'browser', label: '浏览器' },
  { value: 'editor', label: '编辑器' },
  { value: 'thinking', label: '思考' },
];

/** 工位大屏：完整的实时画面 + 干预操作 */
export function FocusModal() {
  const id = useStore((s) => s.focusAgent);
  const agent = useStore((s) => (id ? s.agents[id] : undefined));
  const profile = useStore((s) => s.profile);
  const task = useStore((s) => (agent?.currentTaskId ? s.tasks[agent.currentTaskId] : undefined));
  const [mode, setMode] = useState<ScreenMode | 'live'>('live');
  const [msg, setMsg] = useState('');
  // 大屏按实际像素排版（不放大），保持 16:10
  const [size, setSize] = useState({ w: 1000, h: 625 });

  useEffect(() => {
    setMode('live');
    const fit = () => {
      const w = Math.max(480, Math.min(1400, window.innerWidth - 460, (window.innerHeight - 170) * 1.6));
      setSize({ w: Math.round(w), h: Math.round(w / 1.6) });
    };
    fit();
    window.addEventListener('resize', fit);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && useStore.setState({ focusAgent: null });
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('resize', fit);
      window.removeEventListener('keydown', esc);
    };
  }, [id]);

  if (!id || !agent || !profile) return null;
  const role = profile.roles.find((r) => r.id === agent.roleId)!;
  const close = () => useStore.setState({ focusAgent: null });
  const send = async () => {
    if (!msg.trim()) return;
    await api(`/api/agents/${id}/message`, { text: msg });
    setMsg('');
  };

  return (
    <div className="modal-mask" onClick={close}>
      <div className="focus" onClick={(e) => e.stopPropagation()}>
        <div className="focus-main">
          <div className="focus-tabs">
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as ScreenMode | 'live')}
              options={MODES.map((x) => ({ value: x.value, label: x.value === 'live' ? <span className="live-label"><i className="live-dot" />实时</span> : x.label }))}
            />
            <span className="focus-activity">{agent.activity}</span>
          </div>
          <div className="big-monitor">
            <Screen agentId={id} scale={1} width={size.w} height={size.h} large forceMode={mode === 'live' ? undefined : mode} />
          </div>
        </div>
        <aside className="focus-side">
          <div className="focus-head" style={{ borderColor: role.color }}>
            <div>
              <b>{agent.name}</b> · {role.name}
            </div>
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={close} />
          </div>
          <Descriptions
            className="focus-desc"
            size="small"
            column={1}
            items={[
              { key: 's', label: '状态', children: agent.paused ? '已暂停' : AGENT_STATUS_CN[agent.status] },
              {
                key: 't',
                label: '任务',
                children: task ? (
                  <Space size={4}>
                    <span>{task.id}</span>
                    <Tag color={PRIORITY_COLOR[task.priority]} bordered={false}>
                      {task.priority}
                    </Tag>
                    <span>{STATUS_CN[task.status]}</span>
                  </Space>
                ) : (
                  '—'
                ),
              },
              { key: 'k', label: 'Token', children: `↑${agent.tokens.input.toLocaleString()}  ↓${agent.tokens.output.toLocaleString()}` },
            ]}
          />
          {task && <div className="focus-task">{task.title}</div>}
          <div className="focus-actions">
            <Button
              danger={!agent.paused}
              type={agent.paused ? 'default' : 'primary'}
              icon={agent.paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
              onClick={() => api(`/api/agents/${id}/pause`, { paused: !agent.paused })}
            >
              {agent.paused ? '恢复' : '暂停'}
            </Button>
          </div>
          <div className="say">
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 5 }}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder={agent.status === 'idle' ? '给 TA 下达指示…' : '插话：会在 TA 下一步思考前送达'}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <Button type="primary" icon={<SendOutlined />} onClick={send} disabled={!msg.trim()}>
              发送
            </Button>
          </div>
          <div className="focus-log">
            <LogPanel agentId={id} />
          </div>
        </aside>
      </div>
    </div>
  );
}
