import type { AgentLocation, CompanyProfile } from '@af/shared';

/**
 * 办公室平面图（单位：米）。
 *
 *        北（窗）
 *  ┌────────┬──────────┬────────┐
 *  │ 经理室  │  研发部   │ 运营部  │   后排：经理室 + 各部门
 *  └──门────┴────门────┴───门───┘
 *  ═══════════ 走 廊 ════════════   z = 0
 *  ┌──门──────────────┬──门──────┐
 *  │     会议室        │  茶水间   │   前排：公共区域（朝镜头一面是矮墙）
 *  └──────────────────┴──────────┘
 *        南（镜头）
 *
 * 所有工位朝向 -Z（人背对镜头看屏幕）。旋转角 rot 是绕 Y 轴的角度，0 = 面朝 -Z。
 */

export const DESK_PITCH_X = 2.2;
export const DESK_PITCH_Z = 2.9;
export const CHAIR_Z = 0.62;
/** 键盘离座位中心的距离：普通工位和经理桌保持一致，人到键盘的手感相同 */
export const KB_FROM_SEAT = 0.42;
/**
 * 椅子到桌子中心的距离：经理桌更深（0.9m，前沿在 0.45），椅子略往后放，
 * 奶蛙肚子刚好贴着桌沿；键盘(-0.42)和鼠标垫(前沿 +0.12)也都落在桌面上
 */
export function chairZ(manager: boolean) {
  return manager ? 0.7 : CHAIR_Z;
}
export const CORRIDOR = 2.6;
export const WALL_H = 2.8;
const FRONT_DEPTH = 6;
const MEETING_MIN_W = 7;
const PANTRY_MIN_W = 5.6;

export type RoomKind = 'office' | 'open' | 'meeting' | 'pantry';

export interface DeskLayout {
  agentId: string;
  /** 房间内相对坐标（桌子中心） */
  x: number;
  z: number;
  manager: boolean;
}

export interface RoomLayout {
  id: string;
  name: string;
  kind: RoomKind;
  row: 'back' | 'front';
  cx: number;
  cz: number;
  width: number;
  depth: number;
  /** 门的 x（世界坐标） */
  doorX: number;
  desks: DeskLayout[];
}

export interface Spot {
  x: number;
  z: number;
  rot: number;
  pose: 'desk' | 'sit' | 'stand';
  /** 从房门进来到这个位置要经过的点（不含门） */
  via: [number, number][];
  room: RoomLayout;
}

export interface OfficeLayout {
  rooms: RoomLayout[];
  width: number;
  minZ: number;
  maxZ: number;
}

export function computeLayout(profile: CompanyProfile): OfficeLayout {
  const depts = profile.departments?.length ? profile.departments : [{ id: 'all', name: '办公区', kind: 'open' as const }];
  const fallback = depts.find((d) => d.kind === 'open') ?? depts[0];
  const deptOf = (id?: string) => (depts.some((d) => d.id === id) ? id : fallback.id);

  // ---------- 后排：经理室 + 各部门 ----------
  const back = depts.map((dept) => {
    const members = profile.agents.filter((a) => deptOf(a.departmentId) === dept.id);
    if (dept.kind === 'office') return { dept, members, width: 6.6, rows: 1, cols: 1 };
    const cols = Math.max(1, Math.min(3, members.length));
    const rows = Math.max(1, Math.ceil(members.length / cols));
    return { dept, members, width: Math.max(6.6, cols * DESK_PITCH_X + 2.8), rows, cols };
  });
  const backDepth = Math.max(6.4, ...back.map((b) => b.rows * DESK_PITCH_Z + 2.6));
  let backW = back.reduce((s, b) => s + b.width, 0);

  // ---------- 前排：会议室 + 茶水间，两排总宽对齐 ----------
  let meetingW = MEETING_MIN_W;
  let pantryW = PANTRY_MIN_W;
  if (meetingW + pantryW < backW) {
    const extra = backW - meetingW - pantryW;
    meetingW += extra * 0.6;
    pantryW += extra * 0.4;
  } else {
    // 后排不够宽：把多出来的宽度给最大的开放办公区
    const widest = back.filter((b) => b.dept.kind === 'open').sort((a, b) => b.width - a.width)[0] ?? back[0];
    widest.width += meetingW + pantryW - backW;
    backW = meetingW + pantryW;
  }
  const W = backW;
  const backCz = -CORRIDOR / 2 - backDepth / 2;
  const frontCz = CORRIDOR / 2 + FRONT_DEPTH / 2;

  const rooms: RoomLayout[] = [];
  let cursor = -W / 2;
  for (const b of back) {
    const cx = cursor + b.width / 2;
    const desks: DeskLayout[] = [];
    if (b.dept.kind === 'office') {
      b.members.forEach((a, i) => desks.push({ agentId: a.id, x: -0.6 + i * 2.4, z: -backDepth / 2 + 2.0, manager: a.roleId === profile.managerRoleId }));
    } else {
      b.members.forEach((a, i) => {
        const r = Math.floor(i / b.cols);
        const inRow = Math.min(b.cols, b.members.length - r * b.cols);
        const c = i % b.cols;
        desks.push({
          agentId: a.id,
          x: (c - (inRow - 1) / 2) * DESK_PITCH_X - 0.4,
          z: -backDepth / 2 + 1.6 + r * DESK_PITCH_Z,
          manager: a.roleId === profile.managerRoleId,
        });
      });
    }
    rooms.push({ id: b.dept.id, name: b.dept.name, kind: b.dept.kind, row: 'back', cx, cz: backCz, width: b.width, depth: backDepth, doorX: cx + b.width / 2 - 0.95, desks });
    cursor += b.width;
  }
  rooms.push({ id: 'meeting', name: '会议室', kind: 'meeting', row: 'front', cx: -W / 2 + meetingW / 2, cz: frontCz, width: meetingW, depth: FRONT_DEPTH, doorX: -W / 2 + meetingW - 0.95, desks: [] });
  rooms.push({ id: 'pantry', name: '茶水间', kind: 'pantry', row: 'front', cx: W / 2 - pantryW / 2, cz: frontCz, width: pantryW, depth: FRONT_DEPTH, doorX: W / 2 - pantryW + 0.95, desks: [] });

  return { rooms, width: W, minZ: backCz - backDepth / 2, maxZ: frontCz + FRONT_DEPTH / 2 };
}

// ---------------- 位置与路径 ----------------

/** 朝向：让人面朝 target 的旋转角（模型正面是 -Z） */
export function faceTo(fx: number, fz: number, tx: number, tz: number) {
  return Math.atan2(-(tx - fx), -(tz - fz));
}

export function roomById(l: OfficeLayout, id: string) {
  return l.rooms.find((r) => r.id === id);
}

function deskOf(l: OfficeLayout, agentId: string) {
  for (const room of l.rooms) {
    const d = room.desks.find((x) => x.agentId === agentId);
    if (d) return { room, d, wx: room.cx + d.x, wz: room.cz + d.z };
  }
  return null;
}

/** 门内侧一步的位置 */
function doorInside(r: RoomLayout): [number, number] {
  return r.row === 'back' ? [r.doorX, r.cz + r.depth / 2 - 0.6] : [r.doorX, r.cz - r.depth / 2 + 0.6];
}

function doorOutside(r: RoomLayout): [number, number] {
  return r.row === 'back' ? [r.doorX, r.cz + r.depth / 2 + 0.55] : [r.doorX, r.cz - r.depth / 2 - 0.55];
}

export function deskSpot(l: OfficeLayout, agentId: string): Spot | null {
  const o = deskOf(l, agentId);
  if (!o) return null;
  const x = o.wx;
  const z = o.wz + chairZ(o.d.manager);
  const aisleZ = z + 0.62;
  return { x, z, rot: 0, pose: 'desk', room: o.room, via: [[o.room.doorX, aisleZ], [x, aisleZ]] };
}

export const MEETING_TABLE = { length: 3.6, width: 1.3 };

/** 会议座位：0 号是主持人（长桌东头，正对西头的电视），其余沿长桌两侧 */
export function meetingSpot(l: OfficeLayout, seat: number): Spot {
  const r = roomById(l, 'meeting')!;
  const tx = r.cx + 0.3;
  const tz = r.cz + 0.2;
  const { length: L, width: Wt } = MEETING_TABLE;
  // 和工位一样，椅子离桌沿约 0.3m，坐下手能放到桌上
  const side = Wt / 2 + 0.32;
  const seats: [number, number][] = [
    [tx + L / 2 + 0.36, tz],
    [tx - 1.1, tz - side],
    [tx - 1.1, tz + side],
    [tx, tz - side],
    [tx, tz + side],
    [tx + 1.1, tz - side],
    [tx + 1.1, tz + side],
  ];
  const [x, z] = seats[Math.min(seat, seats.length - 1)];
  const away = z > tz + 0.1 ? 0.6 : z < tz - 0.1 ? -0.6 : 0;
  const ax = away === 0 ? x + (x < tx ? -0.5 : 0.5) : x;
  return { x, z, rot: faceTo(x, z, tx, tz), pose: 'sit', room: r, via: [[ax, z + away]] };
}

export function meetingTable(l: OfficeLayout) {
  const r = roomById(l, 'meeting')!;
  return { x: r.cx + 0.3, z: r.cz + 0.2, room: r };
}

/** 茶水间站位：围着高脚桌和咖啡机 */
export function pantrySpot(l: OfficeLayout, seat: number): Spot {
  const r = roomById(l, 'pantry')!;
  const bx = r.cx - 0.3;
  const bz = r.cz + 0.1;
  const spots: [number, number, number, number][] = [
    [bx - 0.65, bz, bx, bz],
    [bx + 0.65, bz, bx, bz],
    [bx, bz - 0.65, bx, bz],
    [bx, bz + 0.65, bx, bz],
    [r.cx + r.width / 2 - 1.3, r.cz - 1.4, r.cx + r.width / 2, r.cz - 1.4],
    [r.cx + r.width / 2 - 1.3, r.cz - 0.4, r.cx + r.width / 2, r.cz - 0.4],
  ];
  const [x, z, fx, fz] = spots[seat % spots.length];
  return { x, z, rot: faceTo(x, z, fx, fz), pose: 'stand', room: r, via: [] };
}

export function pantryBar(l: OfficeLayout) {
  const r = roomById(l, 'pantry')!;
  return { x: r.cx - 0.3, z: r.cz + 0.1, room: r };
}

/** 站在某人工位旁边（请教同事 / 进经理室汇报） */
export function besideDeskSpot(l: OfficeLayout, agentId: string, seat = 0): Spot | null {
  const o = deskOf(l, agentId);
  if (!o) return null;
  const sx = o.wx;
  const sz = o.wz + chairZ(o.d.manager);
  // 多人同时来找时往后排开
  const x = sx + (o.d.manager ? 1.25 : 0.95) + seat * 0.35;
  const z = sz + (o.d.manager ? 0.15 : 0.3) + seat * 0.6;
  return { x, z, rot: faceTo(x, z, sx, sz), pose: 'stand', room: o.room, via: [[x, z + 0.5]] };
}

export function spotFor(l: OfficeLayout, agentId: string, loc: AgentLocation): Spot | null {
  switch (loc.kind) {
    case 'meeting':
      return meetingSpot(l, loc.seat ?? 0);
    case 'pantry':
      return pantrySpot(l, loc.seat ?? 0);
    case 'office':
    case 'visit':
      return (loc.target && besideDeskSpot(l, loc.target, loc.seat ?? 0)) || deskSpot(l, agentId);
    default:
      return deskSpot(l, agentId);
  }
}

/** 从一个位置走到另一个位置的路径点（出房门 → 走廊 → 进房门） */
export function pathBetween(from: Spot, to: Spot): [number, number][] {
  // via 是“从门口走到该位置”的顺序：离开时倒着走，到达时顺着走
  const leave = [...from.via].reverse();
  const pts: [number, number][] = [];
  if (from.room.id === to.room.id) {
    pts.push(...leave, ...to.via);
  } else {
    const a = from.room;
    const b = to.room;
    pts.push(...leave, doorInside(a), doorOutside(a));
    pts.push([a.doorX, 0], [b.doorX, 0]);
    pts.push(doorOutside(b), doorInside(b), ...to.via);
  }
  pts.push([to.x, to.z]);
  return pts;
}
