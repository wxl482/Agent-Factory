import { useEffect, useMemo, useState } from 'react';
import { Button, Collapse, Drawer, Empty, Input, Segmented, Spin, Tag, Timeline, Tooltip, Typography, message } from 'antd';
import { CheckOutlined, CloseOutlined, CopyOutlined, DownloadOutlined, ExportOutlined, FileImageOutlined, FileOutlined, FileTextOutlined, GlobalOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Approval, ArtifactFile, Task } from '@af/shared';
import { api, workspaceUrl } from '../lib/api';
import { useStore } from '../lib/store';
import { agentName, fmtAgo, fmtCost, fmtDuration, fmtSize, fmtTokens, PRIORITY_COLOR, STATUS_CN } from './util';

/**
 * 交付页：一个目标的全部结果放在一页——交付总结、产出文件（可预览）、子任务明细、花费、过程记录，
 * 待验收时直接在这里通过或打回。
 */

const STATUS_TAG: Partial<Record<Task['status'], string>> = { done: 'success', cancelled: 'default', awaiting_human: 'red', in_progress: 'processing', planning: 'gold' };

const ext = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';
const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);
const WEB = new Set(['html', 'htm']);
const TEXT = new Set(['md', 'txt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'scss', 'py', 'sh', 'yml', 'yaml', 'toml', 'csv', 'xml', 'sql', 'go', 'rs', 'java', 'env', 'ini', 'log', 'vue', 'svelte']);

function kindOf(p: string): 'web' | 'image' | 'text' | 'binary' {
  const e = ext(p);
  if (WEB.has(e)) return 'web';
  if (IMG.has(e)) return 'image';
  if (TEXT.has(e) || !p.includes('.')) return 'text';
  return 'binary';
}

const FILE_ICON = { web: <GlobalOutlined />, image: <FileImageOutlined />, text: <FileTextOutlined />, binary: <FileOutlined /> };

export function DeliveryDrawer() {
  const goalId = useStore((s) => s.deliveryGoal);
  const close = () => useStore.setState({ deliveryGoal: null });
  return (
    <Drawer open={!!goalId} onClose={close} width="min(960px, 92vw)" destroyOnHidden className="delivery-drawer" title={goalId ? <DeliveryTitle id={goalId} /> : null} extra={goalId ? <AcceptanceActions id={goalId} /> : null}>
      {goalId && <DeliveryBody id={goalId} />}
    </Drawer>
  );
}

function DeliveryTitle({ id }: { id: string }) {
  const g = useStore((s) => s.tasks[id]);
  if (!g) return null;
  return (
    <div className="dl-title">
      <span className="prio" style={{ color: PRIORITY_COLOR[g.priority] }}>
        {g.priority}
      </span>
      <span className="dl-title-text">{g.title}</span>
      <Tag color={STATUS_TAG[g.status] ?? 'default'} bordered={false}>
        {g.status === 'awaiting_human' ? '待验收' : STATUS_CN[g.status]}
      </Tag>
    </div>
  );
}

/** 待老板验收时，在交付页右上角直接决定 */
function AcceptanceActions({ id }: { id: string }) {
  const approvals = useStore((s) => s.approvals);
  const pending = Object.values(approvals).find((a) => a.kind === 'acceptance' && a.taskId === id && a.status === 'pending');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  if (!pending) return null;
  const decide = async (approve: boolean) => {
    setBusy(approve ? 'yes' : 'no');
    try {
      await api(`/api/approvals/${pending.id}`, { approve, comment });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="dl-accept">
      <Input size="small" placeholder="验收意见（打回时会转达给经理）" value={comment} onChange={(e) => setComment(e.target.value)} style={{ width: 220 }} />
      <Button size="small" danger icon={<CloseOutlined />} loading={busy === 'no'} disabled={!!busy} onClick={() => decide(false)}>
        打回
      </Button>
      <Button size="small" type="primary" className="btn-ok" icon={<CheckOutlined />} loading={busy === 'yes'} disabled={!!busy} onClick={() => decide(true)}>
        验收通过
      </Button>
    </div>
  );
}

function DeliveryBody({ id }: { id: string }) {
  const tasks = useStore((s) => s.tasks);
  const usage = useStore((s) => s.usage);
  const approvals = useStore((s) => s.approvals);
  const goal = tasks[id];
  const kids = useMemo(() => Object.values(tasks).filter((t) => t.parentId === id).sort((a, b) => a.createdAt - b.createdAt), [tasks, id]);
  if (!goal) return <Empty description="目标不存在" />;

  const done = kids.filter((k) => k.status === 'done').length;
  const rework = kids.reduce((s, k) => s + k.reviewRounds, 0);
  const cost = usage?.byGoal[id];
  const end = goal.finishedAt ?? (goal.status === 'awaiting_human' ? goal.updatedAt : Date.now());
  const budget = usage?.budget.perGoal ? usage.budget.perGoal + (usage.extraGoal[id] ?? 0) : 0;
  // 产出文件随子任务推进而变化：用所有任务的产出清单做依赖，变了就重新拉取
  const artifactKey = [goal, ...kids].map((t) => t.artifacts.join('|')).join(';');

  return (
    <div className="dl-body">
      <div className="dl-stats">
        <Stat label="耗时" value={fmtDuration(end - goal.createdAt)} sub={`创建于 ${fmtAgo(goal.createdAt)}`} />
        <Stat
          label="花费"
          value={fmtCost(cost?.cost)}
          sub={`${fmtTokens((cost?.input ?? 0) + (cost?.output ?? 0))} tokens · ${cost?.calls ?? 0} 次调用${budget ? ` · 预算 ${fmtCost(budget)}` : ''}`}
          warn={!!budget && (cost?.cost ?? 0) >= budget}
        />
        <Stat label="子任务" value={kids.length ? `${done}/${kids.length}` : '规划中'} sub={kids.length ? `${kids.filter((k) => k.status === 'cancelled').length} 个取消` : ''} />
        <Stat label="返工" value={`${rework} 次`} sub={rework ? '评审打回的总次数' : '全部一次通过'} />
      </div>

      <Section title="交付总结">
        {goal.result ? (
          <div className="dl-summary">{goal.result}</div>
        ) : (
          <div className="dl-empty">经理还在推进，所有子任务完成后会在这里写交付总结（产出在哪、怎么用、遗留问题）。</div>
        )}
        {goal.feedback && goal.status !== 'done' && <div className="dl-feedback">老板上次的意见：{goal.feedback}</div>}
      </Section>

      <Section
        title="产出文件"
        extra={
          goal.artifacts.length > 0 || kids.some((k) => k.artifacts.length > 0) ? (
            <Button
              size="small"
              icon={<DownloadOutlined />}
              href={`${useStore.getState().previewBase}__archive/${id}.zip`}
              download={`${id}-artifacts.zip`}
            >
              打包下载 (ZIP)
            </Button>
          ) : null
        }
      >
        <Files goalId={id} refreshKey={artifactKey} />
      </Section>

      <Section title={`子任务 ${kids.length || ''}`}>
        {kids.length ? <Subtasks kids={kids} /> : <div className="dl-empty">还没有拆解子任务。</div>}
      </Section>

      <Section title="过程记录">
        <History goal={goal} kids={kids} approvals={approvals} />
      </Section>
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`dl-stat ${warn ? 'warn' : ''}`}>
      <div className="dl-stat-label">{label}</div>
      <div className="dl-stat-value">{value}</div>
      {sub && <div className="dl-stat-sub">{sub}</div>}
    </div>
  );
}

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="dl-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h4 style={{ margin: 0 }}>{title}</h4>
        {extra}
      </div>
      {children}
    </section>
  );
}

// ---------------- 产出文件 + 预览 ----------------

function Files({ goalId, refreshKey }: { goalId: string; refreshKey: string }) {
  const [files, setFiles] = useState<ArtifactFile[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [reviseInstruction, setReviseInstruction] = useState('');
  const [revising, setRevising] = useState(false);

  useEffect(() => {
    let alive = true;
    api<ArtifactFile[]>(`/api/goals/${goalId}/files`)
      .then((f) => {
        if (!alive) return;
        setFiles(f);
        // 默认选中最值得看的：营销/文档成稿 > 网页 > 说明文档 > 第一个存在的文件
        setSel((cur) =>
          cur && f.some((x) => x.path === cur)
            ? cur
            : (
                f.find((x) => x.exists && /^marketing\/.*\.(md|txt)$/i.test(x.path)) ??
                f.find((x) => x.exists && kindOf(x.path) === 'web' && !/^\.tmp/i.test(x.path)) ??
                f.find((x) => x.exists && /readme|\.md$/i.test(x.path)) ??
                f.find((x) => x.exists)
              )?.path ?? null,
        );
      })
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [goalId, refreshKey, nonce]);

  if (!files) return <Spin size="small" />;
  if (!files.length) return <div className="dl-empty">还没有产出文件。员工用 write_file / edit_file 或命令行脚本生成的文件会自动出现在这里。</div>;
  const cur = files.find((f) => f.path === sel);
  const tasks = useStore.getState().tasks;

  const submitRevise = async () => {
    if (!cur || !reviseInstruction.trim()) return;
    setRevising(true);
    try {
      await api(`/api/goals/${goalId}/revise`, { instruction: reviseInstruction.trim(), path: cur.path });
      message.success('已派发局部微调任务，员工修改完后会自动更新并提请验收');
      setReviseInstruction('');
    } catch (e) {
      message.error(`微调请求失败：${(e as Error).message}`);
    } finally {
      setRevising(false);
    }
  };

  return (
    <div className="dl-files">
      <div className="dl-file-list">
        {files.map((f) => (
          <div key={f.path} className={`dl-file ${f.path === sel ? 'on' : ''} ${f.exists ? '' : 'missing'}`} onClick={() => f.exists && setSel(f.path)}>
            <span className="dl-file-icon">{FILE_ICON[kindOf(f.path)]}</span>
            <div className="dl-file-main">
              <Tooltip title={f.path} placement="left" mouseEnterDelay={0.6}>
                <div className="dl-file-name">{f.path}</div>
              </Tooltip>
              <div className="dl-file-meta">
                {f.exists ? `${fmtSize(f.size)} · ${fmtAgo(f.mtime)}` : '已被删除'}
                {f.taskIds.length > 0 && ` · ${f.taskIds.map((t) => (tasks[t]?.assigneeAgentId ? agentName(tasks[t].assigneeAgentId!) : t)).join('、')}`}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="dl-preview">
        {cur ? (
          <>
            <div className="dl-preview-bar">
              <span className="dl-preview-path">{cur.path}</span>
              <Tooltip title="刷新">
                <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => setNonce((n) => n + 1)} />
              </Tooltip>
              <Tooltip title="新窗口打开">
                <Button type="text" size="small" icon={<ExportOutlined />} href={workspaceUrl(cur.path)} target="_blank" rel="noopener noreferrer" />
              </Tooltip>
              <Tooltip title="下载">
                <Button type="text" size="small" icon={<DownloadOutlined />} href={workspaceUrl(cur.path)} download={cur.path.split('/').pop()} />
              </Tooltip>
            </div>
            {(kindOf(cur.path) === 'text' || kindOf(cur.path) === 'web') && (
              <div style={{ display: 'flex', gap: 8, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
                <Input
                  size="small"
                  placeholder={`对 ${cur.path.split('/').pop()} 提出局部微调（如“把标题改得更口语化”、“配色改成深蓝色”）`}
                  value={reviseInstruction}
                  onChange={(e) => setReviseInstruction(e.target.value)}
                  onPressEnter={submitRevise}
                />
                <Button size="small" type="primary" loading={revising} disabled={!reviseInstruction.trim()} onClick={submitRevise}>
                  ✨ 局部微调
                </Button>
              </div>
            )}
            <Preview key={`${cur.path}:${cur.mtime}:${nonce}`} file={cur} />
          </>
        ) : (
          <div className="dl-empty">选择左侧文件预览</div>
        )}
      </div>
    </div>
  );
}

function Preview({ file }: { file: ArtifactFile }) {
  const kind = kindOf(file.path);
  const url = workspaceUrl(file.path);
  if (kind === 'web') {
    // 沙箱：AI 生成的网页可以运行脚本，但不和本应用同源，拿不到口令也调不了接口
    return <iframe className="dl-frame" src={url} sandbox="allow-scripts allow-forms allow-modals allow-popups" title={file.path} />;
  }
  if (kind === 'image') return <div className="dl-img"><img src={url} alt={file.path} /></div>;
  if (kind === 'binary' || file.size > 2 * 1024 * 1024) {
    return <div className="dl-empty">{kind === 'binary' ? '这个文件类型不支持预览' : '文件较大，不在页面内预览'}，可以新窗口打开或下载。</div>;
  }
  return <TextPreview url={url} md={ext(file.path) === 'md'} />;
}

function TextPreview({ url, md }: { url: string; md: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [mode, setMode] = useState<'read' | 'source'>(md ? 'read' : 'source');
  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((t) => alive && setText(t))
      .catch(() => alive && setText('（读取失败）'));
    return () => {
      alive = false;
    };
  }, [url]);
  if (text === null) return <Spin size="small" />;
  return (
    <div className="dl-text-wrap">
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
        <Button
          size="small"
          icon={<CopyOutlined />}
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => message.success('已复制全文'));
          }}
        >
          复制全文
        </Button>
        {md && (
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as 'read' | 'source')}
            options={[
              { value: 'read', label: '阅读' },
              { value: 'source', label: '源码' },
            ]}
          />
        )}
      </div>
      {md && mode === 'read' ? <Markdown text={text} /> : <pre className="dl-code">{text}</pre>}
    </div>
  );
}

/** 轻量 Markdown 阅读视图：标题、列表、引用、代码块、表格、图片、链接、粗体、行内代码 */
function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');
  const inline = (s: string) =>
    s.split(/(!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g).map((p, i) => {
      if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
      if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
      const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(p);
      if (img) {
        const src = /^https?:\/\//i.test(img[2]) ? img[2] : workspaceUrl(img[2].replace(/^\.\//, ''));
        return <img key={i} src={src} alt={img[1]} style={{ maxWidth: '100%', borderRadius: 6, margin: '6px 0' }} />;
      }
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
      if (link) {
        const href = /^https?:\/\//i.test(link[2]) ? link[2] : workspaceUrl(link[2].replace(/^\.\//, ''));
        return (
          <a key={i} href={href} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>
        );
      }
      return p;
    });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const buf: string[] = [];
      while (++i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i]);
      blocks.push(<pre key={i} className="dl-code">{buf.join('\n')}</pre>);
    } else if (l.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      const parseRow = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const headers = parseRow(l);
      i++; // skip separator line
      const rows: string[][] = [];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
        rows.push(parseRow(lines[++i]));
      }
      blocks.push(
        <div key={i} style={{ overflowX: 'auto', margin: '8px 0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi} style={{ border: '1px solid rgba(255,255,255,0.12)', padding: '6px 10px', textAlign: 'left', background: 'rgba(255,255,255,0.04)' }}>
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={{ border: '1px solid rgba(255,255,255,0.08)', padding: '6px 10px' }}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^#{1,6}\s/.test(l)) {
      const n = /^#+/.exec(l)![0].length;
      blocks.push(<div key={i} className={`md-h md-h${Math.min(n, 4)}`}>{inline(l.replace(/^#+\s*/, ''))}</div>);
    } else if (/^\s*([-*+]|\d+\.)\s/.test(l)) {
      blocks.push(<div key={i} className="md-li" style={{ paddingLeft: 14 + (/^\s*/.exec(l)![0].length / 2) * 14 }}>{inline(l.replace(/^\s*([-*+]|\d+\.)\s/, (m) => (/\d/.test(m) ? m.trim() + ' ' : '• ')))}</div>);
    } else if (l.startsWith('>')) {
      blocks.push(<div key={i} className="md-quote">{inline(l.replace(/^>\s?/, ''))}</div>);
    } else if (l.trim()) {
      blocks.push(<p key={i}>{inline(l)}</p>);
    }
  }
  return <div className="dl-md">{blocks}</div>;
}

// ---------------- 子任务 ----------------

function Subtasks({ kids }: { kids: Task[] }) {
  const usage = useStore((s) => s.usage);
  const roles = useStore((s) => s.profile?.roles);
  return (
    <Collapse
      size="small"
      className="dl-subtasks"
      items={kids.map((k) => ({
        key: k.id,
        label: (
          <div className="dl-st-head">
            <Tag color={STATUS_TAG[k.status] ?? 'default'} bordered={false} className="mini-tag">
              {STATUS_CN[k.status]}
            </Tag>
            <span className="dl-st-title">{k.title}</span>
            <span className="dl-st-meta">
              {k.assigneeAgentId ? agentName(k.assigneeAgentId) : roles?.find((r) => r.id === k.assigneeRoleId)?.name}
              {k.reviewRounds > 0 && <span className="rework"> ↻{k.reviewRounds}</span>}
              {' · '}
              {fmtCost(usage?.byTask[k.id]?.cost)}
              {k.startedAt && ` · ${fmtDuration((k.finishedAt ?? Date.now()) - k.startedAt)}`}
            </span>
          </div>
        ),
        children: (
          <div className="dl-st-body">
            <Field label="要求">{k.description}</Field>
            {k.acceptance && <Field label="验收标准">{k.acceptance}</Field>}
            {k.result && <Field label="员工总结">{k.result}</Field>}
            {k.feedback && <Field label={k.status === 'done' ? '评审意见' : '最近反馈'}>{k.feedback}</Field>}
            {k.artifacts.length > 0 && (
              <Field label="产出">
                {k.artifacts.map((p) => (
                  <Typography.Link key={p} href={workspaceUrl(p)} target="_blank" rel="noopener noreferrer" className="dl-artifact-link">
                    {p}
                  </Typography.Link>
                ))}
              </Field>
            )}
          </div>
        ),
      }))}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dl-field">
      <span className="dl-field-label">{label}</span>
      <div className="dl-field-value">{children}</div>
    </div>
  );
}

// ---------------- 过程记录：决策 + 会议纪要 ----------------

function History({ goal, kids, approvals }: { goal: Task; kids: Task[]; approvals: Record<string, Approval> }) {
  const ids = new Set([goal.id, ...kids.map((k) => k.id)]);
  const decided = Object.values(approvals).filter((a) => a.taskId && ids.has(a.taskId) && a.status !== 'pending');
  const items = [
    { ts: goal.createdAt, color: 'blue', text: <>老板下达目标</> },
    ...decided.map((a) => ({
      ts: a.decidedAt ?? a.createdAt,
      color: a.status === 'approved' ? 'green' : 'red',
      text: (
        <>
          <b>{agentName(a.decidedBy ?? '')}</b> {a.status === 'approved' ? '同意' : '驳回'}：{a.title}
          {a.comment && <div className="dl-tl-note">“{a.comment}”</div>}
        </>
      ),
    })),
    ...kids.filter((k) => k.finishedAt).map((k) => ({ ts: k.finishedAt!, color: k.status === 'done' ? 'green' : 'gray', text: <>子任务{k.status === 'done' ? '完成' : '取消'}：{k.title}</> })),
  ].sort((a, b) => a.ts - b.ts);
  return (
    <>
      <Timeline
        className="dl-timeline"
        items={items.map((it) => ({
          color: it.color,
          content: (
            <div className="dl-tl">
              <span className="dl-tl-time">{fmtAgo(it.ts)}</span>
              {it.text}
            </div>
          ),
        }))}
      />
      {goal.notes.length > 0 && (
        <Collapse
          size="small"
          className="dl-notes"
          items={goal.notes.map((n, i) => ({ key: i, label: n.split('\n')[0].slice(0, 60) || `记录 ${i + 1}`, children: <div className="dl-summary">{n}</div> }))}
        />
      )}
    </>
  );
}
