import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { AgentDef, AgentState, RoleDef } from '@af/shared';
import { useStore } from '../../lib/store';
import { useHtmlPortal, useIdleActivity } from './hooks';
import { pathBetween, spotFor, type OfficeLayout, type Spot } from './layout';
import { ModelPerson } from './ModelPerson';
import { Person, type PersonMode } from './Person';

/**
 * 一个员工在办公室里的“身体”：根据服务端给的位置（工位/会议室/经理室/同事旁/茶水间），
 * 沿走廊走过去并摆出对应姿势；头顶显示名牌、状态和对话气泡。
 */

const STATUS_LABEL: Record<AgentState['status'], [string, string]> = {
  idle: ['空闲', '#8a94a6'],
  thinking: ['思考中', '#a78bfa'],
  working: ['工作中', '#34d399'],
  waiting: ['等待审批', '#fbbf24'],
  paused: ['已暂停', '#94a3b8'],
  error: ['出错', '#f87171'],
};

const MIN_SPEED = 1.4;
const tmpV = new THREE.Vector3();

/** 气泡里只放一句要点：去掉 Markdown 符号，取第一句，最多 40 字；完整内容在日志里 */
function brief(text: string) {
  const flat = text.replace(/[*`#>_~]/g, '').replace(/\s+/g, ' ').trim();
  const first = flat.split(/(?<=[。！？!?；;])/)[0] ?? flat;
  const s = first.length >= 8 ? first : flat;
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

/** 说话气泡：逐字出现 + 声波图标，左侧是说话人的角色色 */
function SpeechBubble({ text, color }: { text: string; color: string }) {
  const full = useMemo(() => brief(text), [text]);
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const t = setInterval(() => setN((x) => (x >= full.length ? x : x + 1)), 35);
    return () => clearInterval(t);
  }, [full]);
  return (
    <div className="speech3d" style={{ borderLeftColor: color }}>
      <span className="wave">
        <i />
        <i />
        <i />
      </span>
      <span className="speech-text">
        {full.slice(0, n)}
        {n < full.length && <span className="speech-caret" />}
      </span>
    </div>
  );
}
const MAX_WALK_S = 4; // 和服务端 WALK_MS 对齐：再远也在约 4 秒内走到

function pathLength(from: [number, number], pts: [number, number][]) {
  let len = 0;
  let [px, pz] = from;
  for (const [x, z] of pts) {
    len += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  return len;
}

function angleLerp(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export const Avatar = memo(function Avatar({ def, role, layout, index }: { def: AgentDef; role: RoleDef; layout: OfficeLayout; index: number }) {
  const agent = useStore((s) => s.agents[def.id]);
  const avatarCfg = useStore((s) => s.profile?.avatar);
  const loc = agent?.location ?? { kind: 'desk' as const };
  const target = useMemo(() => spotFor(layout, def.id, loc), [layout, def.id, loc.kind, loc.target, loc.seat]);
  const idleAct = useIdleActivity(index);
  const portal = useHtmlPortal();

  const group = useRef<THREE.Group>(null);
  const nav = useRef<{ x: number; z: number; rot: number; spot: Spot | null; path: [number, number][]; speed: number }>({
    x: target?.x ?? 0,
    z: target?.z ?? 0,
    rot: target?.rot ?? 0,
    spot: target,
    path: [],
    speed: MIN_SPEED,
  });
  const [moving, setMoving] = useState(false);
  const labelRef = useRef<HTMLDivElement>(null);

  // 目标位置变化 → 规划路径
  useEffect(() => {
    const n = nav.current;
    if (!target) return;
    if (!n.spot) {
      Object.assign(n, { x: target.x, z: target.z, rot: target.rot, spot: target });
      return;
    }
    if (n.spot === target) return;
    const from: Spot = { ...n.spot, x: n.x, z: n.z, via: n.path.length ? [] : n.spot.via };
    n.path = pathBetween(from, target);
    n.speed = Math.max(MIN_SPEED, pathLength([n.x, n.z], n.path) / MAX_WALK_S);
    n.spot = target;
    setMoving(true);
  }, [target]);

  useFrame(({ camera }, dt) => {
    const n = nav.current;
    const g = group.current;
    if (!g) return;
    // 名牌/气泡按距离缩放但限制范围：拉近不会糊满屏幕，拉远也看得清；很远时只显示名字
    const el = labelRef.current;
    if (el) {
      const dist = camera.position.distanceTo(tmpV.set(n.x, 1.6, n.z));
      const sc = Math.min(1.05, Math.max(0.68, 8 / dist));
      el.style.transform = `translate(-50%, -100%) scale(${sc.toFixed(3)})`;
      el.classList.toggle('far', dist > 16);
    }
    // 低帧率设备也要按真实时间走完（只限制切后台回来时的超大 dt）
    let step = n.speed * Math.min(dt, 0.25);
    while (n.path.length && step > 0) {
      const [tx, tz] = n.path[0];
      const dx = tx - n.x;
      const dz = tz - n.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) n.rot = angleLerp(n.rot, Math.atan2(-dx, -dz), Math.min(1, dt * 10));
      if (d <= step) {
        n.x = tx;
        n.z = tz;
        step -= d;
        n.path.shift();
      } else {
        n.x += (dx / d) * step;
        n.z += (dz / d) * step;
        step = 0;
      }
    }
    if (!n.path.length) {
      if (moving) setMoving(false);
      if (n.spot) n.rot = angleLerp(n.rot, n.spot.rot, Math.min(1, dt * 6));
    }
    g.position.set(n.x, 0, n.z);
    g.rotation.y = n.rot;
  });

  if (!agent || !target) return null;
  const status = agent.status;
  const mode: PersonMode = moving ? 'walk' : target.pose;
  const [label, color] = STATUS_LABEL[status];
  const away = loc.kind !== 'desk';
  const activity = away ? loc.reason ?? '' : status !== 'idle' ? agent.activity : '';

  return (
    <group ref={group}>
      {(() => {
        const body = { collar: role.color, status, screen: agent.screen, idleAct, mode, speaking: !!agent.speech, pantry: loc.kind === 'pantry' };
        const builtin = <Person {...body} />;
        return avatarCfg ? <ModelPerson cfg={avatarCfg} fallback={builtin} {...body} /> : builtin;
      })()}
      <Html portal={portal} position={[0, mode === 'desk' || mode === 'sit' ? 1.62 : 1.5, 0]} zIndexRange={[16777271, 16777200]} wrapperClass="html3d-passive">
        <div className="tag3d-wrap" ref={labelRef}>
          {agent.speech && <SpeechBubble text={agent.speech} color={role.color} />}
          <div className={`tag3d ${status}`}>
            <div className="tag3d-name">
              <i style={{ background: role.color }} />
              {def.name}
              <span>{role.name}</span>
            </div>
            <div className="tag3d-status" style={{ color: away ? '#2563eb' : color }}>
              ● {away ? (moving ? '走动中' : '离开工位') : label}
              {activity ? ` · ${activity}` : ''}
            </div>
          </div>
        </div>
      </Html>
    </group>
  );
});
