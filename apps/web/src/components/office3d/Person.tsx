import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import type { AgentStatus } from '@af/shared';

/**
 * 奶蛙：黄色梨形身体、头身一体、两侧小绿眼、浅棕大肚皮、深棕色手脚。
 * 所有员工同一个形象，只有项圈颜色按角色区分。
 *
 * 坐标：原点在脚下（坐着时在椅子正下方），奶蛙面朝 -Z。
 * 模式：desk 坐在工位（打字/用鼠标/托下巴/喝咖啡/刷手机…）、sit 坐着开会、stand 站着（谈话/茶水间）、walk 走路。
 * 腿有髋、膝两个关节；手臂用胶囊连接肩和手。每帧把各部位插值到目标姿态。
 */

export type IdleActivity = 'coffee' | 'phone';
export type PersonMode = 'desk' | 'sit' | 'stand' | 'walk';

const SEAT = 0.49; // 坐着时身体底部高度（椅面）
const STAND = 0.17; // 站着时身体底部高度
const BODY_Z = 0.02;
const NECK = 0.55;
const DESK = 0.285; // 桌面高度（相对坐着的身体底部）
const KB_Z = -0.44; // 键盘位置（相对身体）
const L1 = 0.11; // 大腿（短胖）
const L2 = 0.11; // 小腿

const YELLOW = '#f2b51c';
const BELLY = '#e3c38f';
const DARK = '#5e4a22';

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmp = new THREE.Vector3();

function placeLimb(mesh: THREE.Mesh | null, a: THREE.Vector3, b: THREE.Vector3) {
  if (!mesh) return;
  tmp.subVectors(b, a);
  const len = tmp.length();
  mesh.position.copy(a).addScaledVector(tmp, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, tmp.normalize());
  mesh.scale.set(1, len, 1);
}

function lathe(points: [number, number][]) {
  return new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    48,
  );
}

// 梨形：屁股最宽，向上平滑收窄，和头部在脖子处半径一致，看起来头身一体
const BODY_GEO = lathe([
  [0, 0],
  [0.17, 0.006],
  [0.252, 0.045],
  [0.29, 0.12],
  [0.293, 0.2],
  [0.278, 0.29],
  [0.252, 0.38],
  [0.226, 0.47],
  [0.212, 0.55],
  [0, 0.55], // 封口：头部转动时不会露出空心
]);
// 圆顶脑袋：比原来更宽更矮
const HEAD_GEO = lathe([
  [0, 0],
  [0.212, 0],
  [0.209, 0.06],
  [0.2, 0.12],
  [0.183, 0.18],
  [0.155, 0.23],
  [0.112, 0.268],
  [0.058, 0.288],
  [0, 0.294],
]);
const DEPTH = 0.86; // 前后方向压扁一点

interface Pose {
  base: number; // 身体底部高度
  lean: number;
  l: THREE.Vector3;
  r: THREE.Vector3;
  pitch: number; // 正 = 抬头
  yaw: number;
  roll: number;
  gazeY: number;
  eyeOpen: number;
  hipL: number;
  hipR: number;
  kneeL: number;
  kneeR: number;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const SIT_LEGS = { hipL: Math.PI / 2, hipR: Math.PI / 2, kneeL: -Math.PI / 2, kneeR: -Math.PI / 2 };
const STAND_LEGS = { hipL: 0, hipR: 0, kneeL: 0, kneeR: 0 };

export function Person({
  collar,
  status,
  screen,
  idleAct,
  mode,
  speaking,
  pantry,
}: {
  collar: string;
  status: AgentStatus;
  screen: string;
  idleAct: IdleActivity;
  mode: PersonMode;
  speaking: boolean;
  /** 在茶水间：站着端咖啡 */
  pantry?: boolean;
}) {
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Group>(null);
  const eyeL = useRef<THREE.Group>(null);
  const eyeR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Mesh>(null);
  const armR = useRef<THREE.Mesh>(null);
  const shoulderL = useRef<THREE.Mesh>(null);
  const shoulderR = useRef<THREE.Mesh>(null);
  const handL = useRef<THREE.Group>(null);
  const handR = useRef<THREE.Group>(null);
  const hipL = useRef<THREE.Group>(null);
  const hipR = useRef<THREE.Group>(null);
  const kneeL = useRef<THREE.Group>(null);
  const kneeR = useRef<THREE.Group>(null);
  const mug = useRef<THREE.Group>(null);
  const phone = useRef<THREE.Group>(null);
  const bubble = useRef<THREE.Group>(null);

  const cur = useRef<Pose>({
    base: SEAT,
    lean: 0.1,
    l: v(-0.12, 0.3, -0.22),
    r: v(0.12, 0.3, -0.22),
    pitch: 0,
    yaw: 0,
    roll: 0,
    gazeY: 0,
    eyeOpen: 1,
    ...SIT_LEGS,
  });
  const phase = useMemo(() => Math.random() * 10, []);

  const mats = useMemo(
    () => ({
      yellow: new THREE.MeshStandardMaterial({ color: YELLOW, roughness: 0.62 }),
      belly: new THREE.MeshStandardMaterial({ color: BELLY, roughness: 0.75 }),
      dark: new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.7 }),
      white: new THREE.MeshStandardMaterial({ color: '#fbfbf5', roughness: 0.3 }),
      iris: new THREE.MeshStandardMaterial({ color: '#4bb86a', roughness: 0.25 }),
      pupil: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.2 }),
      mouth: new THREE.MeshStandardMaterial({ color: '#6b3f12', roughness: 0.6 }),
      blush: new THREE.MeshStandardMaterial({ color: '#f59a6b', roughness: 0.8, transparent: true, opacity: 0.55 }),
      collar: new THREE.MeshStandardMaterial({ color: collar, roughness: 0.4, metalness: 0.1 }),
      bell: new THREE.MeshStandardMaterial({ color: '#f5d76e', roughness: 0.25, metalness: 0.75 }),
      ceramic: new THREE.MeshStandardMaterial({ color: '#f2efe9', roughness: 0.3 }),
      coffee: new THREE.MeshStandardMaterial({ color: '#4b2e1e', roughness: 0.2 }),
      phoneBody: new THREE.MeshStandardMaterial({ color: '#1c1d22', roughness: 0.35, metalness: 0.4 }),
      phoneScreen: new THREE.MeshBasicMaterial({ color: '#7fb6ff' }),
      bubble: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3, transparent: true, opacity: 0.92 }),
    }),
    [collar],
  );

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime + phase;
    const k = 1 - Math.exp(-dt * 6);

    // ---------- 目标姿态 ----------
    let p: Pose;
    let holdMug = false;
    let holdPhone = false;
    const sitBase = { base: SEAT, ...SIT_LEGS };
    const standBase = { base: STAND, ...STAND_LEGS };
    const talkHand = v(0.22, 0.42 + Math.sin(t * 5) * 0.05, -0.24 + Math.cos(t * 3.3) * 0.03);

    if (mode === 'walk') {
      const w = t * 9;
      const s = Math.sin(w);
      p = {
        ...standBase,
        base: STAND + Math.abs(Math.cos(w)) * 0.025,
        lean: -0.06,
        l: v(-0.27, 0.15, -0.02 - s * 0.12),
        r: v(0.27, 0.15, -0.02 + s * 0.12),
        pitch: 0,
        yaw: 0,
        roll: s * 0.04,
        gazeY: 0,
        eyeOpen: 1,
        hipL: s * 0.5,
        hipR: -s * 0.5,
        kneeL: -Math.max(0, -Math.cos(w)) * 0.7,
        kneeR: -Math.max(0, Math.cos(w)) * 0.7,
      };
    } else if (mode === 'stand') {
      holdMug = !!pantry;
      const sip = holdMug && t % 8 < 2.2;
      p = {
        ...standBase,
        lean: 0,
        l: v(-0.27, 0.13, -0.04),
        r: speaking ? talkHand : holdMug ? (sip ? v(0.05, 0.62, -0.2) : v(0.13, 0.4, -0.25)) : v(0.27, 0.13, -0.04),
        pitch: sip ? 0.12 : speaking ? Math.sin(t * 2) * 0.05 : 0.02,
        yaw: speaking ? Math.sin(t * 1.3) * 0.12 : 0,
        roll: 0,
        gazeY: 0,
        eyeOpen: sip ? 0.35 : 1,
      };
    } else if (mode === 'sit') {
      // 开会：手放桌上，发言时打手势，听别人说话时偶尔点头
      p = {
        ...sitBase,
        lean: -0.04,
        l: v(-0.15, DESK, -0.34),
        r: speaking ? talkHand : v(0.15, DESK, -0.34),
        pitch: speaking ? Math.sin(t * 2) * 0.05 : Math.max(0, Math.sin(t * 0.9)) * -0.08,
        yaw: speaking ? Math.sin(t * 1.1) * 0.15 : 0,
        roll: 0,
        gazeY: 0,
        eyeOpen: 1,
      };
    } else if (status === 'working' && screen === 'browser') {
      p = { ...sitBase, lean: -0.1, l: v(-0.13, DESK, KB_Z + 0.02), r: v(0.36, DESK, KB_Z + 0.03), pitch: 0.02, yaw: 0, roll: 0, gazeY: 0, eyeOpen: 1 };
    } else if (status === 'working') {
      p = { ...sitBase, lean: -0.15, l: v(-0.12, DESK, KB_Z), r: v(0.12, DESK, KB_Z), pitch: 0, yaw: 0, roll: 0, gazeY: -0.004, eyeOpen: 1 };
    } else if (status === 'thinking') {
      // 托下巴：右手撑下巴，左手托右肘，抬头看斜上方
      p = { ...sitBase, lean: 0.02, l: v(0.05, 0.36, -0.24), r: v(0.04, 0.6, -0.27), pitch: 0.16 + Math.sin(t * 0.6) * 0.04, yaw: 0.22 + Math.sin(t * 0.4) * 0.1, roll: 0.12, gazeY: 0.012, eyeOpen: 1 };
    } else if (status === 'waiting') {
      p = { ...sitBase, lean: 0, l: v(-0.15, DESK, -0.38), r: v(0.15, DESK, -0.4), pitch: 0.04, yaw: Math.sin(t * 1.2) * 0.6, roll: 0, gazeY: 0, eyeOpen: 1 };
    } else if (status === 'paused') {
      p = { ...sitBase, lean: 0.16, l: v(-0.1, 0.3, -0.22), r: v(0.1, 0.3, -0.22), pitch: -0.32, yaw: 0, roll: 0.08, gazeY: 0, eyeOpen: 0.08 };
    } else if (status === 'error') {
      p = { ...sitBase, lean: 0, l: v(-0.17, 0.86, -0.02), r: v(0.17, 0.86, -0.02), pitch: -0.05, yaw: Math.sin(t * 6) * 0.25, roll: 0, gazeY: 0, eyeOpen: 1 };
    } else if (idleAct === 'coffee') {
      const sip = t % 7 < 2.4;
      holdMug = true;
      p = { ...sitBase, lean: 0.12, l: v(-0.11, 0.3, -0.22), r: sip ? v(0.05, 0.62, -0.2) : v(0.15, 0.36, -0.27), pitch: sip ? 0.12 : 0, yaw: 0, roll: 0, gazeY: 0, eyeOpen: sip ? 0.35 : 1 };
    } else {
      holdPhone = true;
      p = { ...sitBase, lean: 0.06, l: v(-0.05, 0.42, -0.27), r: v(0.05, 0.42, -0.27), pitch: -0.28, yaw: Math.sin(t * 0.3) * 0.05, roll: 0, gazeY: -0.012, eyeOpen: 1 };
    }

    const c = cur.current;
    // 走路时腿和手臂要跟得上节奏，插值更快
    const kk = mode === 'walk' ? Math.min(1, k * 3) : k;
    c.base += (p.base - c.base) * kk;
    c.lean += (p.lean - c.lean) * k;
    c.l.lerp(p.l, kk);
    c.r.lerp(p.r, kk);
    c.pitch += (p.pitch - c.pitch) * k;
    c.yaw += (p.yaw - c.yaw) * k;
    c.roll += (p.roll - c.roll) * kk;
    c.gazeY += (p.gazeY - c.gazeY) * k;
    c.hipL += (p.hipL - c.hipL) * kk;
    c.hipR += (p.hipR - c.hipR) * kk;
    c.kneeL += (p.kneeL - c.kneeL) * kk;
    c.kneeR += (p.kneeR - c.kneeR) * kk;
    const blink = t % 4.3 < 0.13 ? 0.1 : 1;
    c.eyeOpen += (Math.min(p.eyeOpen, blink) - c.eyeOpen) * Math.min(1, k * 3);

    // ---------- 身体 / 头 / 腿 ----------
    if (root.current) root.current.position.y = c.base;
    const breath = Math.sin(t * (status === 'idle' || status === 'paused' ? 1.4 : 2.2)) * 0.012;
    if (body.current) {
      body.current.rotation.set(c.lean, 0, c.roll);
      body.current.scale.set(1 + breath, 1 + breath * 0.5, 1 + breath);
    }
    if (head.current) head.current.rotation.set(c.pitch, c.yaw, status === 'thinking' && mode === 'desk' ? 0.12 : 0);
    for (const e of [eyeL.current, eyeR.current]) {
      if (!e) continue;
      e.scale.y = c.eyeOpen;
      e.children[1].position.y = c.gazeY;
      e.children[2].position.y = c.gazeY;
    }
    if (mouth.current) mouth.current.scale.set(1, speaking ? 1 + Math.max(0, Math.sin(t * 14)) * 1.6 : 1, 1);
    hipL.current?.rotation.set(c.hipL, 0, 0);
    hipR.current?.rotation.set(c.hipR, 0, 0);
    kneeL.current?.rotation.set(c.kneeL, 0, 0);
    kneeR.current?.rotation.set(c.kneeR, 0, 0);

    // ---------- 手 ----------
    const l = c.l.clone();
    const r = c.r.clone();
    if (mode === 'desk' && status === 'working' && screen !== 'browser') {
      l.y += Math.max(0, Math.sin(t * 18)) * 0.014;
      r.y += Math.max(0, Math.sin(t * 18 + Math.PI)) * 0.014;
      l.x += Math.sin(t * 2.3) * 0.02;
      r.x += Math.sin(t * 1.9) * 0.02;
    } else if (mode === 'desk' && status === 'working') {
      r.x += Math.sin(t * 1.5) * 0.025;
      r.z += Math.cos(t * 1.1) * 0.02;
    } else if (mode === 'desk' && status === 'waiting') {
      r.y += Math.max(0, Math.sin(t * 14)) * 0.012;
    } else if (holdPhone) {
      r.y += Math.max(0, Math.sin(t * 9)) * 0.006;
    }
    const shL = v(-0.205, 0.42, -0.04).applyAxisAngle(X_AXIS, c.lean);
    const shR = v(0.205, 0.42, -0.04).applyAxisAngle(X_AXIS, c.lean);
    shoulderL.current?.position.copy(shL);
    shoulderR.current?.position.copy(shR);
    placeLimb(armL.current, shL, l);
    placeLimb(armR.current, shR, r);
    if (handL.current) {
      handL.current.position.copy(l);
      handL.current.quaternion.setFromUnitVectors(Z_AXIS, l.clone().sub(shL).normalize());
    }
    if (handR.current) {
      handR.current.position.copy(r);
      handR.current.quaternion.setFromUnitVectors(Z_AXIS, r.clone().sub(shR).normalize());
    }

    // ---------- 道具：杯子 / 手机 / 思考泡泡 ----------
    if (mug.current) {
      mug.current.visible = holdMug;
      mug.current.position.set(r.x, r.y - 0.045, r.z - 0.035);
      const tilt = holdMug && (pantry ? t % 8 < 2.2 : t % 7 < 2.4) ? 0.9 : 0;
      mug.current.rotation.x += (tilt - mug.current.rotation.x) * k;
    }
    if (phone.current) {
      const s = phone.current.scale.x + ((holdPhone ? 1 : 0) - phone.current.scale.x) * k;
      phone.current.scale.setScalar(Math.max(0.0001, s));
      phone.current.position.set((l.x + r.x) / 2, (l.y + r.y) / 2 + 0.02, (l.z + r.z) / 2);
    }
    if (bubble.current) {
      const on = status === 'thinking' && mode !== 'walk' ? 1 : 0;
      const s = bubble.current.scale.x + (on - bubble.current.scale.x) * k;
      bubble.current.scale.setScalar(Math.max(0.0001, s));
      bubble.current.children.forEach((ch, i) => {
        ch.position.y = ch.userData.y + Math.sin(t * 2 + i) * 0.012;
      });
    }
  });

  return (
    <group ref={root} position={[0, SEAT, BODY_Z]}>
      {/* ---------- 身体（绕屁股旋转实现前倾/后靠） ---------- */}
      <group ref={body}>
        <mesh geometry={BODY_GEO} material={mats.yellow} scale={[1, 1, DEPTH]} castShadow receiveShadow />
        {/* 肚皮：贴着身体的浅色椭圆，只微微鼓出 */}
        <mesh material={mats.belly} position={[0, 0.2, -0.172]} scale={[0.2, 0.21, 0.085]}>
          <sphereGeometry args={[1, 32, 24]} />
        </mesh>

        {/* 项圈（唯一区分角色的地方）+ 铃铛 */}
        <mesh material={mats.collar} position={[0, NECK - 0.012, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[1, DEPTH, 1.5]}>
          <torusGeometry args={[0.211, 0.0125, 10, 64]} />
        </mesh>
        <mesh material={mats.bell} position={[0, NECK - 0.045, -0.19]} castShadow>
          <sphereGeometry args={[0.022, 16, 12]} />
        </mesh>

        {/* ---------- 头 ---------- */}
        <group ref={head} position={[0, NECK, 0]}>
          <mesh geometry={HEAD_GEO} material={mats.yellow} scale={[1, 1, DEPTH]} castShadow />
          {[-1, 1].map((s) => (
            <group key={s} position={[s * 0.118, 0.2, -0.098]} rotation={[0, s * -0.62, 0]}>
              {/* 青蛙式的眼窝鼓包，让眼睛“长”在头上而不是贴上去 */}
              <mesh material={mats.yellow} position={[0, -0.004, 0.012]} scale={[1, 0.9, 1]}>
                <sphereGeometry args={[0.054, 24, 18]} />
              </mesh>
              <group ref={s < 0 ? eyeL : eyeR}>
                <mesh material={mats.white} position={[0, 0, -0.012]}>
                  <sphereGeometry args={[0.045, 24, 18]} />
                </mesh>
                <mesh material={mats.iris} position={[0, 0, -0.043]} scale={[1, 1, 0.55]}>
                  <sphereGeometry args={[0.03, 20, 16]} />
                </mesh>
                <mesh material={mats.pupil} position={[0, 0, -0.057]} scale={[1, 1, 0.5]}>
                  <sphereGeometry args={[0.016, 16, 12]} />
                </mesh>
                <mesh material={mats.white} position={[0.01, 0.012, -0.064]}>
                  <sphereGeometry args={[0.006, 8, 6]} />
                </mesh>
              </group>
            </group>
          ))}
          {/* 腮红 */}
          {[-1, 1].map((s) => (
            <mesh key={s} material={mats.blush} position={[s * 0.118, 0.105, -0.142]} rotation={[0, s * -0.7, 0]} scale={[1, 0.6, 0.3]}>
              <sphereGeometry args={[0.03, 16, 10]} />
            </mesh>
          ))}
          {/* 微笑的嘴 */}
          <group ref={mouth} position={[0, 0.118, -0.178]}>
            <mesh material={mats.mouth} rotation={[0.25, 0, Math.PI + 0.55]}>
              <torusGeometry args={[0.04, 0.0065, 8, 24, Math.PI * 0.55]} />
            </mesh>
          </group>

          {/* 思考泡泡 */}
          <group ref={bubble} position={[0.16, 0.42, 0.02]} scale={0.0001}>
            {[
              [0, 0, 0, 0.022],
              [0.06, 0.07, 0, 0.032],
              [0.13, 0.17, 0, 0.075],
            ].map(([x, y, z, r], i) => (
              <mesh key={i} material={mats.bubble} position={[x, y, z]} userData={{ y }}>
                <sphereGeometry args={[r, 20, 16]} />
              </mesh>
            ))}
          </group>
        </group>
      </group>

      {/* ---------- 短胳膊 + 深棕色手 ---------- */}
      <mesh ref={armL} material={mats.yellow} castShadow>
        <cylinderGeometry args={[0.044, 0.05, 1, 16, 1, true]} />
      </mesh>
      <mesh ref={armR} material={mats.yellow} castShadow>
        <cylinderGeometry args={[0.044, 0.05, 1, 16, 1, true]} />
      </mesh>
      {/* 圆肩：盖住胳膊和身体的接缝 */}
      {[shoulderL, shoulderR].map((ref, i) => (
        <mesh key={i} ref={ref} material={mats.yellow} castShadow>
          <sphereGeometry args={[0.054, 18, 14]} />
        </mesh>
      ))}
      {[handL, handR].map((ref, i) => (
        <group key={i} ref={ref}>
          <mesh material={mats.dark} scale={[1.15, 0.75, 1.05]} castShadow>
            <sphereGeometry args={[0.05, 16, 12]} />
          </mesh>
          {[-1, 0, 1].map((f) => (
            <mesh key={f} material={mats.dark} position={[f * 0.026, 0, 0.042]} rotation={[Math.PI / 2, 0, 0]}>
              <capsuleGeometry args={[0.012, 0.03, 4, 8]} />
            </mesh>
          ))}
        </group>
      ))}

      {/* ---------- 腿：髋 → 大腿 → 膝 → 小腿 → 深棕色脚 ---------- */}
      {[-1, 1].map((s) => (
        <group key={s} ref={s < 0 ? hipL : hipR} position={[s * 0.12, 0.09, -0.04]}>
          <mesh material={mats.yellow} position={[0, -L1 / 2, 0]} castShadow>
            <capsuleGeometry args={[0.082, 0.02, 8, 16]} />
          </mesh>
          <group ref={s < 0 ? kneeL : kneeR} position={[0, -L1, 0]}>
            <mesh material={mats.yellow} position={[0, -L2 / 2, 0]} castShadow>
              <capsuleGeometry args={[0.07, 0.03, 8, 16]} />
            </mesh>
            <group position={[0, -L2, -0.03]}>
              <mesh material={mats.dark} scale={[1, 0.42, 1.4]} castShadow>
                <sphereGeometry args={[0.068, 16, 12]} />
              </mesh>
              {[-1, 0, 1].map((f) => (
                <mesh key={f} material={mats.dark} position={[f * 0.034, -0.006, -0.088]} scale={[1, 0.7, 1.4]}>
                  <sphereGeometry args={[0.021, 10, 8]} />
                </mesh>
              ))}
            </group>
          </group>
        </group>
      ))}

      {/* ---------- 道具（身体坐标） ---------- */}
      <group ref={mug} visible={false}>
        <mesh material={mats.ceramic} position={[0, 0.05, 0]} castShadow>
          <cylinderGeometry args={[0.038, 0.034, 0.1, 20]} />
        </mesh>
        <mesh material={mats.ceramic} position={[0.045, 0.05, 0]} rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.022, 0.007, 8, 16]} />
        </mesh>
        <mesh material={mats.coffee} position={[0, 0.098, 0]}>
          <cylinderGeometry args={[0.033, 0.033, 0.002, 20]} />
        </mesh>
      </group>
      <group ref={phone} scale={0.0001}>
        <group rotation={[-1.0, 0, 0]}>
          <RoundedBox args={[0.075, 0.15, 0.009]} radius={0.004} material={mats.phoneBody} castShadow />
          <mesh material={mats.phoneScreen} position={[0, 0, 0.0052]}>
            <planeGeometry args={[0.066, 0.138]} />
          </mesh>
        </group>
      </group>
    </group>
  );
}
