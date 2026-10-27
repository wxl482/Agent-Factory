import { useStore } from '../../lib/store';

const STATUS = { gathering: '召集中', ongoing: '进行中', done: '已结束' } as const;

/** 会议室大屏：显示正在进行（或最近一次）会议的议题、参会人、发言实录和纪要 */
export function MeetingBoard() {
  const meetings = useStore((s) => s.meetings);
  const agents = useStore((s) => s.agents);
  const roles = useStore((s) => s.profile?.roles);
  const list = Object.values(meetings).sort((a, b) => b.createdAt - a.createdAt);
  const m = list.find((x) => x.status !== 'done') ?? list[0];
  const name = (id: string) => agents[id]?.name ?? id;
  const color = (id: string) => roles?.find((r) => r.id === agents[id]?.roleId)?.color ?? '#94a3b8';

  if (!m) {
    return (
      <div className="meeting-board idle">
        <div className="mb-logo">会议室</div>
        <div className="mb-sub">暂无会议</div>
      </div>
    );
  }
  return (
    <div className="meeting-board">
      <div className="mb-head">
        <span className={`mb-status ${m.status}`}>● {STATUS[m.status]}</span>
        <span className="mb-topic">{m.topic}</span>
      </div>
      <div className="mb-people">
        {[m.hostId, ...m.participants].map((id, i) => (
          <span key={id} style={{ borderColor: color(id) }}>
            {name(id)}
            {i === 0 && <em>主持</em>}
          </span>
        ))}
      </div>
      {m.status === 'done' && m.summary ? (
        <div className="mb-summary">
          <b>会议纪要</b>
          <pre>{m.summary}</pre>
        </div>
      ) : (
        <div className="mb-lines">
          {m.transcript.slice(-5).map((l) => (
            <div key={l.ts} className="mb-line">
              <b style={{ color: color(l.agentId) }}>{name(l.agentId)}：</b>
              {l.text}
            </div>
          ))}
          {m.status !== 'done' && <div className="mb-wait">{m.status === 'gathering' ? '等待参会人到场…' : '…'}</div>}
        </div>
      )}
    </div>
  );
}
