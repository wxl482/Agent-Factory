import { Button } from 'antd';
import { CheckCircleFilled, PlusOutlined, RightOutlined } from '@ant-design/icons';
import type { GoalTemplate } from '@af/shared';
import { useStore } from '../lib/store';
import { goalTemplates, openGoalWith } from './Panels';

/** 一个目标都还没有时的新手引导：这是什么、怎么开始、要不要先做准备 */
export function Welcome() {
  const profile = useStore((s) => s.profile);
  const llm = useStore((s) => s.llm);
  const usage = useStore((s) => s.usage);
  const settings = useStore((s) => s.settings);
  const im = useStore((s) => s.im);
  const manager = profile?.agents.find((a) => a.roleId === profile.managerRoleId)?.name ?? '经理';
  const templates: GoalTemplate[] = profile ? goalTemplates() : [];

  const demo = llm?.provider === 'mock';
  const budgetSet = !!(usage?.budget.daily || usage?.budget.perGoal);
  const notifySet = !!(settings?.notify.webhook || im?.dingtalk.state === 'online');
  const checks = [
    {
      done: !demo,
      title: demo ? '接入真实模型' : `已接入 ${llm?.model}`,
      desc: demo ? '现在是演示模式：按剧本跑，不花钱，适合先熟悉。接入后员工才会按你的目标真正思考产出' : '员工正在使用真实模型工作',
      action: () => useStore.setState({ showModel: true }),
    },
    {
      done: budgetSet,
      title: budgetSet ? '已设置预算' : '设置预算',
      desc: '超出每日或单目标预算会自动暂停并问你，不怕花超',
      action: () => useStore.setState({ showCost: true }),
    },
    {
      done: notifySet,
      title: notifySet ? '已开启消息提醒' : '开启消息提醒',
      desc: '需要你决策、交付待验收时推送到钉钉 / 飞书 / 企业微信，不用一直盯着页面',
      action: () => useStore.setState({ showRules: true }),
    },
  ];

  return (
    <div className="welcome">
      <div className="welcome-hero">
        <h3>👋 欢迎来到{profile?.name ?? '你的 AI 公司'}</h3>
        <p>你是老板。下达一个目标，{manager}会拆解并派给合适的员工，员工在工位上真实干活，做完交给你验收。</p>
        <ol className="welcome-steps">
          <li>
            <b>1</b>下达目标
          </li>
          <li>
            <b>2</b>看团队干活<small>点工位能看屏幕</small>
          </li>
          <li>
            <b>3</b>验收交付
          </li>
        </ol>
      </div>

      <h4>试试这些目标</h4>
      <div className="welcome-templates">
        {templates.map((t) => (
          <button key={t.label} className="welcome-tpl" onClick={() => openGoalWith(t)}>
            <span className="welcome-tpl-icon">{t.icon}</span>
            <span className="welcome-tpl-main">
              <b>{t.label}</b>
              <small>{t.title.replace(/【([^】]*)】/g, '$1')}</small>
            </span>
            <RightOutlined />
          </button>
        ))}
      </div>
      <Button block type="primary" icon={<PlusOutlined />} onClick={() => openGoalWith()}>
        自己写一个目标
      </Button>

      <h4>准备工作（可选，随时可以做）</h4>
      <div className="welcome-checks">
        {checks.map((c) => (
          <button key={c.title} className={`welcome-check ${c.done ? 'done' : ''}`} onClick={c.action}>
            {c.done ? <CheckCircleFilled className="welcome-check-icon" /> : <span className="welcome-check-dot" />}
            <span className="welcome-check-main">
              <b>{c.title}</b>
              <small>{c.desc}</small>
            </span>
            <RightOutlined />
          </button>
        ))}
      </div>
    </div>
  );
}
