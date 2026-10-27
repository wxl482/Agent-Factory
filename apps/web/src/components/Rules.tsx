import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Input, InputNumber, Modal, Segmented, Select, Switch, Tag } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import type { Approver, NotifyEvent, Settings } from '@af/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { toast } from '../lib/ui';

/** 公司规则：审批权限、超时处理、消息推送 */
export function RulesModal() {
  const show = useStore((s) => s.showRules);
  const settings = useStore((s) => s.settings);
  const close = () => useStore.setState({ showRules: false });
  return (
    <Modal open={show} onCancel={close} footer={null} width={560} title="公司规则" destroyOnHidden>
      {settings && <RulesForm initial={settings} onDone={close} />}
    </Modal>
  );
}

const APPROVER_OPTS: { value: Approver; label: string }[] = [
  { value: 'auto', label: '直接放行' },
  { value: 'manager', label: '经理审批' },
  { value: 'human', label: '我来审批' },
];

const EVENTS: { value: NotifyEvent; label: string }[] = [
  { value: 'decision', label: '需要我决策' },
  { value: 'acceptance', label: '交付待验收' },
  { value: 'budget', label: '超出预算' },
  { value: 'goal_done', label: '目标完成' },
  { value: 'blocked', label: '任务受阻' },
];

function RulesForm({ initial, onDone }: { initial: Settings; onDone: () => void }) {
  const [s, setS] = useState<Settings>(initial);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => setS(initial), [initial]);
  const set = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => setS((p) => ({ ...p, [k]: { ...p[k], ...v } }));
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  const save = async (close = true) => {
    setSaving(true);
    try {
      await api('/api/settings', s);
      if (close) {
        toast?.success('规则已保存');
        onDone();
      }
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      // 先保存地址再测试，测的就是界面上填的这个
      if (dirty) await save(false);
      await api('/api/settings/test-notify', {});
      toast?.success('已发送测试消息，去群里看看');
    } finally {
      setTesting(false);
    }
  };

  const timeoutOn = s.timeout.minutes > 0;
  const dingOnline = useStore((x) => x.im?.dingtalk.state === 'online');
  return (
    <div className="rules">
      <Card title="审批权限" note="经理自己的 R2 操作始终由你审批">
        <Row label="中风险操作 R1" hint="装依赖、递归删除、丢弃改动">
          <Segmented size="small" value={s.approval.r1} onChange={(v) => set('approval', { r1: v as Approver })} options={APPROVER_OPTS} />
        </Row>
        <Row label="高风险操作 R2" hint="sudo、git push、对外发布">
          <Segmented size="small" value={s.approval.r2} onChange={(v) => set('approval', { r2: v as 'manager' | 'human' })} options={APPROVER_OPTS.filter((o) => o.value !== 'auto')} />
        </Row>
        {s.approval.r2 === 'manager' && <Alert type="warning" showIcon className="rules-alert" message="经理可能在你不知情时推送代码或对外发布" />}
        <Row label="交付验收" hint="关闭后经理确认即算完成">
          <Switch checked={s.approval.humanAcceptance} onChange={(v) => set('approval', { humanAcceptance: v })} />
        </Row>
      </Card>

      <Card title="超时处理" note="操作审批超时自动驳回；预算告警和交付验收始终等你本人">
        <Row label="超时自动处理" hint="我没及时处理时，按规则替我决定">
          <div className="rules-inline">
            {timeoutOn && (
              <InputNumber size="small" min={1} max={10080} step={10} value={s.timeout.minutes} onChange={(v) => set('timeout', { minutes: v ?? 1 })} suffix="分钟" style={{ width: 110 }} />
            )}
            <Switch checked={timeoutOn} onChange={(v) => set('timeout', { minutes: v ? 30 : 0 })} />
          </div>
        </Row>
        {timeoutOn && (
          <Row label="请示超时后" hint="员工或经理向你请示的问题">
            <Segmented
              size="small"
              value={s.timeout.questionAction}
              onChange={(v) => set('timeout', { questionAction: v as 'delegate' | 'wait' })}
              options={[
                { value: 'delegate', label: '授权经理判断' },
                { value: 'wait', label: '继续等我' },
              ]}
            />
          </Row>
        )}
      </Card>

      <Card title="消息推送" note="支持飞书 / 企业微信 / 钉钉群机器人。安全设置选「关键词」，填 Agent Factory">
        <Field label="Webhook 地址">
          <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" value={s.notify.webhook} onChange={(e) => set('notify', { webhook: e.target.value })} allowClear />
        </Field>
        <Field label="访问地址（可选）" hint="附在消息末尾，手机上点开就能处理">
          <Input placeholder="http://你的服务器:8787" value={s.notify.publicUrl} onChange={(e) => set('notify', { publicUrl: e.target.value })} />
        </Field>
        <Field label="推送事件">
          <div className="rules-tags">
            {EVENTS.map((e) => (
              <Tag.CheckableTag
                key={e.value}
                checked={s.notify.events.includes(e.value)}
                onChange={(on) => set('notify', { events: on ? [...s.notify.events, e.value] : s.notify.events.filter((x) => x !== e.value) })}
              >
                {e.label}
              </Tag.CheckableTag>
            ))}
          </div>
        </Field>
        <Button size="small" icon={<SendOutlined />} disabled={!s.notify.webhook && !(dingOnline && s.im.dingtalkAdmins.length)} loading={testing} onClick={test} className="rules-test">
          发送测试消息
        </Button>
      </Card>

      <ImCard s={s} onAdmins={(ids) => setS((p) => ({ ...p, im: { ...p.im, dingtalkAdmins: ids } }))} />

      <div className="rules-actions">
        <Button onClick={onDone}>取消</Button>
        <Button type="primary" disabled={!dirty} loading={saving} onClick={() => save()}>
          保存
        </Button>
      </div>
    </div>
  );
}

const IM_STATE = {
  off: { status: 'default', text: '未配置' },
  connecting: { status: 'processing', text: '连接中' },
  online: { status: 'success', text: '已连接' },
  error: { status: 'error', text: '连接失败' },
} as const;

/** 钉钉应用机器人：在群里 @ 它或单聊下指令 */
function ImCard({ s, onAdmins }: { s: Settings; onAdmins: (ids: string[]) => void }) {
  const st = useStore((x) => x.im?.dingtalk) ?? { state: 'off' as const };
  const meta = IM_STATE[st.state];
  return (
    <Card title="聊天机器人" note="管理员可以派活、审批、暂停；其他人只能查状态。不知道 userId？在钉钉里对机器人发「我是谁」">
      <Row label="钉钉" hint={st.state === 'off' ? '在 .env 填 DINGTALK_CLIENT_ID / SECRET 后重启' : (st.detail ?? 'Stream 模式，不需要公网地址')}>
        <Badge status={meta.status} text={meta.text} />
      </Row>
      <Field label="管理员 userId">
        <Select
          mode="tags"
          value={s.im.dingtalkAdmins}
          onChange={(v) => onAdmins(v)}
          tokenSeparators={[',', '，', ' ']}
          placeholder="输入 userId 后回车，可填多个"
          open={false}
          suffixIcon={null}
          style={{ width: '100%' }}
        />
      </Field>
    </Card>
  );
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rules-card">
      <h4>{title}</h4>
      <div className="rules-card-body">{children}</div>
      {note && <div className="rules-note">{note}</div>}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rules-field">
      <div className="rules-field-label">
        {label}
        {hint && <span>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rules-row">
      <div className="rules-label">
        {label}
        {hint && <div className="rules-hint">{hint}</div>}
      </div>
      <div className="rules-ctl">{children}</div>
    </div>
  );
}
