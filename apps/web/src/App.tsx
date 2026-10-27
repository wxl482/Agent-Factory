import { Badge, Button, Tabs, Tooltip } from 'antd';
import { DoubleLeftOutlined, DoubleRightOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useStore } from './lib/store';
import { Inbox } from './components/Inbox';
import { LogPanel } from './components/LogPanel';
import { Office3D } from './components/office3d/Office3D';
import { FocusModal, NewGoalDialog, TopBar } from './components/Panels';
import { DeliveryDrawer } from './components/Delivery';
import { CostModal } from './components/CostPanel';
import { RulesModal } from './components/Rules';
import { TaskBoard } from './components/TaskBoard';

export function App() {
  const tab = useStore((s) => s.tab);
  const sideCollapsed = useStore((s) => s.sideCollapsed);
  const pending = useStore((s) => Object.values(s.approvals).filter((a) => a.status === 'pending' && a.approver === 'human').length);
  const activeTasks = useStore((s) => Object.values(s.tasks).filter((t) => t.kind === 'task' && !['done', 'cancelled'].includes(t.status)).length);
  const paused = useStore((s) => s.globalPaused);

  const openTab = (nextTab: typeof tab) => {
    useStore.setState({ tab: nextTab, sideCollapsed: false });
  };

  return (
    <div className={`app ${paused ? 'all-paused' : ''}`}>
      <TopBar />
      <main>
        <Office3D />
        {sideCollapsed && (
          <div className="side-dock">
            <Tooltip title="展开右侧功能区" placement="left">
              <button className="side-dock-btn expand" onClick={() => useStore.setState({ sideCollapsed: false })}>
                <DoubleLeftOutlined />
              </button>
            </Tooltip>
            <Tooltip title={`待我决策${pending ? ` (${pending})` : ''}`} placement="left">
              <button className={`side-dock-btn ${tab === 'inbox' ? 'active' : ''}`} onClick={() => openTab('inbox')}>
                <Badge count={pending} size="small" offset={[6, -4]}>
                  <span>📥</span>
                </Badge>
              </button>
            </Tooltip>
            <Tooltip title={`任务${activeTasks ? ` (${activeTasks})` : ''}`} placement="left">
              <button className={`side-dock-btn ${tab === 'tasks' ? 'active' : ''}`} onClick={() => openTab('tasks')}>
                <Badge count={activeTasks} size="small" offset={[6, -4]} color="#3b4252">
                  <span>📋</span>
                </Badge>
              </button>
            </Tooltip>
            <Tooltip title="实时日志" placement="left">
              <button className={`side-dock-btn ${tab === 'logs' ? 'active' : ''}`} onClick={() => openTab('logs')}>
                <span>📜</span>
              </button>
            </Tooltip>
          </div>
        )}
        <aside className={`side ${sideCollapsed ? 'collapsed' : ''}`}>
          <Tooltip title={sideCollapsed ? '展开面板' : '收拢面板'} placement="left">
            <button className="side-handle" onClick={() => useStore.setState({ sideCollapsed: !sideCollapsed })}>
              {sideCollapsed ? <LeftOutlined /> : <RightOutlined />}
            </button>
          </Tooltip>
          <div className="side-inner">
            <Tabs
              className="side-tabs"
              activeKey={tab}
              centered
              onChange={(k) => useStore.setState({ tab: k as typeof tab })}
              tabBarExtraContent={{
                right: (
                  <Tooltip title="收拢右侧功能区" placement="bottomRight">
                    <Button
                      type="text"
                      size="small"
                      className="side-collapse-btn"
                      icon={<DoubleRightOutlined />}
                      onClick={() => useStore.setState({ sideCollapsed: true })}
                    />
                  </Tooltip>
                ),
              }}
              items={[
                {
                  key: 'inbox',
                  label: (
                    <Badge count={pending} size="small" offset={[8, -2]}>
                      <span>📥 待我决策</span>
                    </Badge>
                  ),
                },
                {
                  key: 'tasks',
                  label: (
                    <Badge count={activeTasks} size="small" offset={[8, -2]} color="#3b4252">
                      <span>📋 任务</span>
                    </Badge>
                  ),
                },
                { key: 'logs', label: '📜 实时日志' },
              ]}
            />
            <div className="tab-body">
              {tab === 'inbox' && <Inbox />}
              {tab === 'tasks' && <TaskBoard />}
              {tab === 'logs' && <LogPanel />}
            </div>
          </div>
        </aside>
      </main>
      {paused && <div className="paused-banner">⏸ 全公司已暂停</div>}
      <NewGoalDialog />
      <FocusModal />
      <DeliveryDrawer />
      <CostModal />
      <RulesModal />
    </div>
  );
}
