import * as THREE from 'three';

/**
 * 程序化人形骨骼驱动：给“有骨骼、没动画”的模型（例如 Tripo 生成的）摆姿势。
 *
 * 做法：记下绑定姿势时每根骨头的朝向（骨头 → 子骨头的方向），运行时给出目标方向（在“员工空间”里：
 * +Y 向上、-Z 向前、+X 是员工的右手边），把骨头最小角度地转过去。父骨头先转、子骨头后转。
 * 只控制主要关节（脊柱、头、上臂、前臂、大腿、小腿），twist 等辅助骨头跟随父骨头。
 */

export type Side = 'L' | 'R';
type LimbKey = 'thigh' | 'calf' | 'upperarm' | 'forearm';
export type BoneKey = 'hips' | 'spine' | 'chest' | 'neck' | 'head' | `${Side}_${LimbKey}` | `${Side}_foot` | `${Side}_hand`;

/** 统一骨骼名：去掉 mixamorig: 等前缀，转小写 */
function norm(name: string) {
  return name.replace(/^.*[:|]/, '').toLowerCase();
}

function sideOf(n: string): Side | null {
  if (/^(l_|left|l\.)|(_l|\.l)$/.test(n)) return 'L';
  if (/^(r_|right|r\.)|(_r|\.r)$/.test(n)) return 'R';
  return null;
}

/** 按常见命名（Tripo / Mixamo / 通用）找主要骨骼 */
export function findBones(root: THREE.Object3D): Partial<Record<BoneKey, THREE.Bone>> {
  const out: Partial<Record<BoneKey, THREE.Bone>> = {};
  const spines: THREE.Bone[] = [];
  root.traverse((o) => {
    const b = o as THREE.Bone;
    if (!b.isBone) return;
    const n = norm(b.name);
    if (/twist|roll|end$|_end|nub/.test(n)) return;
    const side = sideOf(n);
    const set = (k: BoneKey) => {
      if (!out[k]) out[k] = b;
    };
    if (side) {
      if (/thigh|upleg|upperleg/.test(n)) set(`${side}_thigh`);
      else if (/calf|shin|lowerleg|(^|_|left|right)leg$/.test(n)) set(`${side}_calf`);
      else if (/foot|ankle/.test(n) && !/toe/.test(n)) set(`${side}_foot`);
      else if (/forearm|lowerarm/.test(n)) set(`${side}_forearm`);
      else if (/upperarm|(^|_|left|right)arm$/.test(n)) set(`${side}_upperarm`);
      else if (/hand$|wrist/.test(n)) set(`${side}_hand`);
      return;
    }
    if (/^(hip|hips|pelvis)$/.test(n)) set('hips');
    else if (/spine|chest|waist/.test(n)) spines.push(b);
    else if (/neck/.test(n)) set('neck');
    else if (/^head$/.test(n)) set('head');
  });
  // 脊柱：取最靠下的一节控制前倾，最上的一节作为胸口
  const depth = (b: THREE.Object3D) => {
    let d = 0;
    for (let p = b.parent; p; p = p.parent) d++;
    return d;
  };
  spines.sort((a, b) => depth(a) - depth(b));
  const spineWithChild = spines.filter((s) => s.children.some((c) => (c as THREE.Bone).isBone));
  if (spineWithChild.length) {
    out.spine = spineWithChild[Math.min(1, spineWithChild.length - 1)];
    out.chest = spineWithChild[spineWithChild.length - 1];
  }
  return out;
}

interface Joint {
  bone: THREE.Bone;
  /** 绑定姿势下，骨头指向（模型空间） */
  restDir: THREE.Vector3;
  /** 骨头自身坐标系里“指向子骨头”的轴 */
  axisLocal: THREE.Vector3;
  /** 绑定姿势下的局部旋转 */
  restLocal: THREE.Quaternion;
  /** 骨头长度（模型单位） */
  length: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** 一根骨头“指向”哪：取它和第一个非 twist 子骨头的连线 */
function tipOf(b: THREE.Bone, bones: Partial<Record<BoneKey, THREE.Bone>>, key: BoneKey): THREE.Object3D | null {
  const next: Partial<Record<BoneKey, BoneKey>> = {
    spine: 'neck',
    chest: 'neck',
    neck: 'head',
    L_thigh: 'L_calf',
    R_thigh: 'R_calf',
    L_calf: 'L_foot',
    R_calf: 'R_foot',
    L_upperarm: 'L_forearm',
    R_upperarm: 'R_forearm',
    L_forearm: 'L_hand',
    R_forearm: 'R_hand',
  };
  const k = next[key];
  if (k && bones[k]) return bones[k]!;
  return (b.children.find((c) => (c as THREE.Bone).isBone && !/twist/i.test(c.name)) as THREE.Bone) ?? null;
}

export interface PoseDirs {
  /** 方向都在员工空间：+Y 上、-Z 前、+X 右 */
  spine?: THREE.Vector3;
  L_thigh?: THREE.Vector3;
  R_thigh?: THREE.Vector3;
  L_calf?: THREE.Vector3;
  R_calf?: THREE.Vector3;
  L_upperarm?: THREE.Vector3;
  R_upperarm?: THREE.Vector3;
  L_forearm?: THREE.Vector3;
  R_forearm?: THREE.Vector3;
  /** 头部附加转动：yaw 左右、pitch 抬头为正、roll 歪头 */
  head?: { yaw: number; pitch: number; roll: number };
  /** 手的目标位置（员工空间，原点在座位/脚下地面）。有它就用 IK 算整条手臂；'chin' = 托下巴 */
  handL?: THREE.Vector3 | 'chin';
  handR?: THREE.Vector3 | 'chin';
}

/** IK 需要的上下文：世界坐标 → 员工空间，以及模型缩放 */
export interface IkContext {
  toAvatar: (world: THREE.Vector3) => THREE.Vector3;
  scale: number;
}

type DirKey = Exclude<keyof PoseDirs, 'head' | 'handL' | 'handR'>;
const ORDER: DirKey[] = ['spine', 'L_thigh', 'R_thigh', 'L_calf', 'R_calf', 'L_upperarm', 'R_upperarm', 'L_forearm', 'R_forearm'];

export class HumanoidRig {
  readonly bones: Partial<Record<BoneKey, THREE.Bone>>;
  private joints = new Map<DirKey, Joint>();
  private headRest?: THREE.Quaternion;
  /** 让模型正面朝 -Z 需要绕 Y 转的角度 */
  readonly autoYaw: number;
  /** 绑定姿势下胯部高度（模型空间） */
  readonly hipY: number;
  readonly valid: boolean;
  /** 当前每根骨头的目标方向（插值用） */
  private cur = new Map<DirKey, THREE.Vector3>();
  private curHead = { yaw: 0, pitch: 0, roll: 0 };
  private curHand: Partial<Record<Side, THREE.Vector3>> = {};

  constructor(private root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    this.bones = findBones(root);
    const b = this.bones;
    this.valid = !!(b.L_thigh && b.R_thigh && b.L_calf && b.R_calf && b.L_upperarm && b.R_upperarm && b.L_forearm && b.R_forearm);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const posOf = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion()).invert();

    // 朝向：右 = 右肩 - 左肩，上 = 头 - 胯，前 = 上 × 右
    let yaw = 0;
    if (b.L_upperarm && b.R_upperarm && (b.head || b.neck) && (b.hips || b.L_thigh)) {
      const right = posOf(b.R_upperarm).sub(posOf(b.L_upperarm));
      const hip = b.hips ? posOf(b.hips) : posOf(b.L_thigh!).add(posOf(b.R_thigh!)).multiplyScalar(0.5);
      const up = posOf((b.head ?? b.neck)!).sub(hip);
      const fwd = new THREE.Vector3().crossVectors(up, right);
      // 当前正面的偏航角，再反转回 -Z
      yaw = -Math.atan2(-fwd.x, -fwd.z);
    }
    this.autoYaw = yaw;
    this.hipY = b.hips ? posOf(b.hips).y : b.L_thigh ? posOf(b.L_thigh).y : 0;

    for (const key of ORDER) {
      const bone = b[key as BoneKey];
      if (!bone) continue;
      const tip = tipOf(bone, b, key as BoneKey);
      if (!tip) continue;
      const span = posOf(tip).sub(posOf(bone));
      const dir = span.clone().normalize();
      const q = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(rootQ);
      const axisLocal = dir.clone().applyQuaternion(q.clone().invert());
      this.joints.set(key, { bone, restDir: dir, axisLocal, restLocal: bone.quaternion.clone(), length: span.length() });
    }
    if (b.head) this.headRest = b.head.quaternion.clone();
  }

  /** 手臂总长（员工空间，米） */
  armReach(scale: number) {
    const a = this.joints.get('L_upperarm');
    const f = this.joints.get('L_forearm');
    return a && f ? (a.length + f.length) * scale : 0;
  }

  /** 两肩中点（员工空间） */
  shoulderMid(ik: IkContext) {
    const l = this.bones.L_upperarm!.getWorldPosition(new THREE.Vector3());
    const r = this.bones.R_upperarm!.getWorldPosition(new THREE.Vector3());
    return ik.toAvatar(l.add(r).multiplyScalar(0.5));
  }

  /** 两骨骼 IK：已知肩、手目标、两段长度和肘部朝向，求上臂/前臂方向（员工空间） */
  private solveArm(side: Side, target: THREE.Vector3, ik: IkContext) {
    const up = this.joints.get(`${side}_upperarm`)!;
    const fo = this.joints.get(`${side}_forearm`)!;
    const S = ik.toAvatar(up.bone.getWorldPosition(new THREE.Vector3()));
    const L1 = up.length * ik.scale;
    const L2 = fo.length * ik.scale;
    const toT = target.clone().sub(S);
    const d = Math.min(Math.max(toT.length(), Math.abs(L1 - L2) + 1e-4), (L1 + L2) * 0.999);
    const dir = toT.normalize();
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // 肘部朝外、朝下、略朝后
    const sx = side === 'L' ? -1 : 1;
    const pole = new THREE.Vector3(sx * 0.6, -1, 0.5);
    pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const E = S.clone().addScaledVector(dir, a).addScaledVector(pole, h);
    const hand = S.clone().addScaledVector(dir, d);
    return { upper: E.clone().sub(S), fore: hand.sub(E) };
  }

  /**
   * 摆姿势。avatarToModel：把员工空间的方向转到模型空间（抵消外层的朝向旋转）。
   * k：本帧插值系数（0~1），让姿势切换平滑。
   * 每根骨头先继承父骨头当前的转动，再从那里最小角度地摆到目标方向——这样关节之间的扭转是连续的，
   * 不会出现手腕、手肘被“拧”变形。
   */
  apply(dirs: PoseDirs, avatarToModel: THREE.Quaternion, k: number, ik?: IkContext) {
    const rootQInv = this.root.getWorldQuaternion(_q2).invert().clone();
    const overrides = new Map<DirKey, THREE.Vector3>();
    for (const key of ORDER) {
      const j = this.joints.get(key);
      if (!j) continue;
      // 上臂轮到时脊柱已经摆好，此时算 IK 得到的肩膀位置是准的
      if (ik && (key === 'L_upperarm' || key === 'R_upperarm')) {
        const side: Side = key === 'L_upperarm' ? 'L' : 'R';
        const spec = side === 'L' ? dirs.handL : dirs.handR;
        if (spec) {
          let want: THREE.Vector3;
          if (spec === 'chin') {
            // 托下巴：头骨根部往前一点、略往下
            const head = this.bones.head ?? this.bones.neck;
            const hp = head ? ik.toAvatar(head.getWorldPosition(new THREE.Vector3())) : new THREE.Vector3(0, 1, 0);
            want = hp.add(new THREE.Vector3(side === 'L' ? -0.02 : 0.02, -0.03, -this.armReach(ik.scale) * 0.35));
          } else want = spec;
          let ch = this.curHand[side];
          if (!ch) this.curHand[side] = ch = want.clone();
          ch.lerp(want, Math.min(1, k * 1.5));
          const sol = this.solveArm(side, ch, ik);
          overrides.set(key, sol.upper);
          overrides.set(side === 'L' ? 'L_forearm' : 'R_forearm', sol.fore);
        } else delete this.curHand[side];
      }
      const want = overrides.get(key) ?? dirs[key];
      if (!want) continue;
      const target = _v.copy(want).normalize().applyQuaternion(avatarToModel);
      let c = this.cur.get(key);
      if (!c) this.cur.set(key, (c = j.restDir.clone()));
      // IK 结果本身已经平滑过（手的目标在插值），这里直接跟上，避免手滑动时滞后
      c.lerp(target, overrides.has(key) ? 1 : k).normalize();
      // 继承父骨头当前的转动，再最小角度摆到目标方向
      const parentModel = j.bone.parent!.getWorldQuaternion(new THREE.Quaternion()).premultiply(rootQInv);
      const current = parentModel.clone().multiply(j.restLocal);
      const currentDir = j.axisLocal.clone().applyQuaternion(current);
      const desired = _q.setFromUnitVectors(currentDir, c).multiply(current);
      j.bone.quaternion.copy(parentModel.invert().multiply(desired));
      j.bone.updateMatrixWorld(true);
    }
    const head = this.bones.head;
    if (head && this.headRest && dirs.head) {
      const h = this.curHead;
      h.yaw += (dirs.head.yaw - h.yaw) * k;
      h.pitch += (dirs.head.pitch - h.pitch) * k;
      h.roll += (dirs.head.roll - h.roll) * k;
      // 在员工空间里绕轴转，再换到头骨的局部空间
      const parentModel = head.parent!.getWorldQuaternion(new THREE.Quaternion()).premultiply(rootQInv);
      const restModel = parentModel.clone().multiply(this.headRest);
      const toModel = avatarToModel;
      const fromModel = toModel.clone().invert();
      const extra = new THREE.Quaternion().setFromEuler(new THREE.Euler(h.pitch, h.yaw, h.roll, 'YXZ'));
      // extra 在员工空间 → 模型空间：toModel × extra × fromModel
      const extraModel = toModel.clone().multiply(extra).multiply(fromModel);
      const desired = extraModel.multiply(restModel);
      head.quaternion.copy(parentModel.invert().multiply(desired));
      head.updateMatrixWorld(true);
    }
  }

  /** 从骨骼当前的实际姿态（例如刚播完的动画）重新记下各关节方向，之后从这里平滑过渡 */
  resync() {
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    for (const [key, j] of this.joints) {
      const tip = tipOf(j.bone, this.bones, key as BoneKey);
      if (!tip) continue;
      const a = j.bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      const b = tip.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      this.cur.set(key, b.sub(a).normalize());
    }
  }
}

// ---------------- 姿势库 ----------------

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** 键盘、鼠标、桌沿在员工空间的位置（原点是座位中心地面） */
const KB_Y = 0.79;
const KB_Z = -0.42;

export interface PoseInput {
  mode: 'desk' | 'sit' | 'stand' | 'walk';
  status: string;
  screen: string;
  idleAct: 'coffee' | 'phone';
  speaking: boolean;
  pantry?: boolean;
  t: number;
}

/** 根据员工状态生成每根骨头的目标方向（员工空间） */
export function poseFor(p: PoseInput): PoseDirs {
  const { t } = p;
  const sitLegs = {
    L_thigh: v(-0.05, -0.12, -1),
    R_thigh: v(0.05, -0.12, -1),
    L_calf: v(-0.02, -1, 0.08),
    R_calf: v(0.02, -1, 0.08),
  };
  const standLegs = { L_thigh: v(-0.04, -1, 0), R_thigh: v(0.04, -1, 0), L_calf: v(0, -1, 0.02), R_calf: v(0, -1, 0.02) };
  const armsDown = { L_upperarm: v(-0.18, -1, 0.02), R_upperarm: v(0.18, -1, 0.02), L_forearm: v(-0.05, -1, -0.25), R_forearm: v(0.05, -1, -0.25) };
  const talk = (side: 1 | -1) => ({ up: v(0.3 * side, -0.8, -0.5), fore: v(0.15 * side, 0.35 + Math.sin(t * 5) * 0.25, -1) });

  if (p.mode === 'walk') {
    const s = Math.sin(t * 9);
    return {
      spine: v(0, 1, -0.06),
      L_thigh: v(-0.04, -1, -0.5 * s),
      R_thigh: v(0.04, -1, 0.5 * s),
      L_calf: v(0, -1, -0.5 * s + Math.max(0, s) * 0.7),
      R_calf: v(0, -1, 0.5 * s + Math.max(0, -s) * 0.7),
      L_upperarm: v(-0.15, -1, 0.4 * s),
      R_upperarm: v(0.15, -1, -0.4 * s),
      L_forearm: v(-0.05, -1, 0.3 * s - 0.3),
      R_forearm: v(0.05, -1, -0.3 * s - 0.3),
      head: { yaw: 0, pitch: 0, roll: s * 0.03 },
    };
  }
  if (p.mode === 'stand') {
    const sip = p.pantry && t % 8 < 2.2;
    const tk = talk(1);
    return {
      spine: v(0, 1, 0),
      ...standLegs,
      ...armsDown,
      ...(p.speaking ? { R_upperarm: tk.up, R_forearm: tk.fore } : p.pantry ? { R_upperarm: v(0.2, -0.9, -0.4), R_forearm: sip ? v(-0.4, 1, -0.3) : v(-0.2, 0.3, -1) } : {}),
      head: { yaw: p.speaking ? Math.sin(t * 1.3) * 0.15 : 0, pitch: sip ? 0.2 : 0, roll: 0 },
    };
  }
  if (p.mode === 'sit') {
    const tk = talk(1);
    // 开会：双手放在会议桌上（桌沿在身前约 0.32m），发言时右手打手势
    return {
      spine: v(0, 1, -0.08),
      ...sitLegs,
      handL: v(-0.16, KB_Y, -0.4),
      ...(p.speaking ? { R_upperarm: tk.up, R_forearm: tk.fore } : { handR: v(0.16, KB_Y, -0.4) }),
      head: { yaw: p.speaking ? Math.sin(t * 1.1) * 0.2 : 0, pitch: p.speaking ? 0 : Math.max(0, Math.sin(t * 0.9)) * -0.12, roll: 0 },
    };
  }

  // 工位
  // 键盘中心在 x=-0.04；鼠标在 x=0.36
  const typing = { handL: v(-0.17, KB_Y, KB_Z), handR: v(0.09, KB_Y, KB_Z) };
  switch (p.status) {
    case 'working': {
      if (p.screen === 'browser') {
        return { spine: v(0, 1, -0.12), ...sitLegs, handL: typing.handL, handR: v(0.36 + Math.sin(t * 1.5) * 0.02, KB_Y - 0.01, KB_Z + 0.02 + Math.cos(t * 1.1) * 0.02), head: { yaw: 0, pitch: -0.05, roll: 0 } };
      }
      // 两手交替轻敲键盘
      const tap = Math.max(0, Math.sin(t * 18)) * 0.012;
      const tap2 = Math.max(0, Math.sin(t * 18 + Math.PI)) * 0.012;
      return {
        spine: v(0, 1, -0.15),
        ...sitLegs,
        handL: v(-0.17 + Math.sin(t * 2.3) * 0.02, KB_Y + tap, KB_Z),
        handR: v(0.09 + Math.sin(t * 1.9) * 0.02, KB_Y + tap2, KB_Z),
        head: { yaw: 0, pitch: -0.08, roll: 0 },
      };
    }
    case 'thinking':
      return {
        spine: v(0, 1, 0),
        ...sitLegs,
        // 托下巴：右手撑下巴，左手搭在桌沿
        handL: v(-0.12, KB_Y, -0.3),
        handR: 'chin',
        head: { yaw: 0.25 + Math.sin(t * 0.4) * 0.1, pitch: 0.2 + Math.sin(t * 0.6) * 0.05, roll: 0.12 },
      };
    case 'waiting':
      // 等审批：手搭在桌沿，右手指敲桌面，左右张望
      return { spine: v(0, 1, 0), ...sitLegs, handL: v(-0.16, KB_Y, -0.3), handR: v(0.16, KB_Y + Math.max(0, Math.sin(t * 14)) * 0.012, -0.32), head: { yaw: Math.sin(t * 1.2) * 0.6, pitch: 0.05, roll: 0 } };
    case 'paused':
      return { spine: v(0, 1, 0.12), ...sitLegs, L_upperarm: v(-0.15, -1, -0.2), R_upperarm: v(0.15, -1, -0.2), L_forearm: v(0.3, -0.5, -1), R_forearm: v(-0.3, -0.5, -1), head: { yaw: 0, pitch: -0.45, roll: 0.1 } };
    case 'error':
      return { spine: v(0, 1, 0), ...sitLegs, L_upperarm: v(-0.7, 0.5, 0), R_upperarm: v(0.7, 0.5, 0), L_forearm: v(0.6, 0.6, 0), R_forearm: v(-0.6, 0.6, 0), head: { yaw: Math.sin(t * 6) * 0.25, pitch: -0.1, roll: 0 } };
    default: {
      if (p.idleAct === 'coffee') {
        const sip = t % 7 < 2.4;
        return {
          spine: v(0, 1, 0.1),
          ...sitLegs,
          L_upperarm: v(-0.15, -1, -0.3),
          L_forearm: v(0.35, -0.4, -1),
          R_upperarm: v(0.25, -0.8, -0.5),
          R_forearm: sip ? v(-0.45, 1, -0.3) : v(-0.25, 0.4, -1),
          head: { yaw: 0, pitch: sip ? 0.2 : 0, roll: 0 },
        };
      }
      return {
        spine: v(0, 1, 0.04),
        ...sitLegs,
        L_upperarm: v(-0.2, -0.85, -0.45),
        R_upperarm: v(0.2, -0.85, -0.45),
        L_forearm: v(0.25, 0.45, -1),
        R_forearm: v(-0.25, 0.45, -1),
        head: { yaw: Math.sin(t * 0.3) * 0.05, pitch: -0.35, roll: 0 },
      };
    }
  }
}
