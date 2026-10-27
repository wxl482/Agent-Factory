import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { useAnimations } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AgentStatus, AvatarAction, AvatarModelConfig } from '@af/shared';
import type { IdleActivity, PersonMode } from './Person';
import { HumanoidRig, poseFor } from './humanoid';

/** 坐下时胯关节的高度（椅面约 0.5m） */
const SEAT_HIP_Y = 0.56;

/**
 * 外部员工模型（GLB / glTF / FBX / OBJ）。
 * - 自动缩放到配置的身高、脚踩地面、水平居中
 * - 材质名匹配 collarMaterial 的部分按角色上色（项圈）
 * - 按员工实时状态选择动画（名字可在配置里映射，否则按关键词自动匹配）；没有动画的模型用简单的起伏代替
 */

interface Props {
  cfg: AvatarModelConfig;
  collar: string;
  status: AgentStatus;
  screen: string;
  idleAct: IdleActivity;
  mode: PersonMode;
  speaking: boolean;
  pantry?: boolean;
}

const KEYWORDS: Record<AvatarAction, RegExp> = {
  idle: /idle|stand|breath|待机|站/i,
  walk: /walk|run|走/i,
  sit: /sit|seat|坐/i,
  type: /typ|keyboard|打字|敲/i,
  mouse: /mouse|鼠标/i,
  think: /think|ponder|思考/i,
  talk: /talk|speak|说话|讲/i,
  phone: /phone|手机/i,
  drink: /drink|coffee|cup|喝/i,
  wait: /wait|look|张望|等/i,
  sleep: /sleep|doze|nap|睡/i,
};

/** 当前状态想播放的动作（按优先顺序，找不到就往后退） */
function wantedActions(p: Props): AvatarAction[] {
  if (p.mode === 'walk') return ['walk', 'idle'];
  if (p.mode === 'stand') return p.speaking ? ['talk', 'idle'] : p.pantry ? ['drink', 'idle'] : ['idle'];
  if (p.mode === 'sit') return p.speaking ? ['talk', 'sit', 'idle'] : ['sit', 'idle'];
  // 工位
  switch (p.status) {
    case 'working':
      return p.screen === 'browser' ? ['mouse', 'type', 'sit', 'idle'] : ['type', 'sit', 'idle'];
    case 'thinking':
      return ['think', 'sit', 'idle'];
    case 'waiting':
      return ['wait', 'sit', 'idle'];
    case 'paused':
      return ['sleep', 'sit', 'idle'];
    case 'idle':
      return [p.idleAct === 'coffee' ? 'drink' : 'phone', 'sit', 'idle'];
    default:
      return ['sit', 'idle'];
  }
}

function resolveClip(clips: THREE.AnimationClip[], cfg: AvatarModelConfig, action: AvatarAction) {
  const named = cfg.clips?.[action];
  if (named) return clips.find((c) => c.name === named)?.name;
  return clips.find((c) => KEYWORDS[action].test(c.name))?.name;
}

function Rig({ src, animations, ...p }: Props & { src: THREE.Object3D; animations: THREE.AnimationClip[] }) {
  const { cfg, collar } = p;
  const group = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);

  // 每个员工一份独立拷贝（带骨骼的模型要用 SkeletonUtils.clone），材质也各自拷贝以便项圈上色
  const { root, scale, offset, rig } = useMemo(() => {
    const obj = cloneSkinned(src);
    const collarRe = new RegExp(cfg.collarMaterial ?? 'collar|项圈', 'i');
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      const recolor = (mat: THREE.Material) => {
        const c = mat.clone() as THREE.MeshStandardMaterial;
        if (collarRe.test(mat.name) || collarRe.test(m.name)) c.color?.set(collar);
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(recolor) : recolor(m.material);
      // 蒙皮模型的包围盒按绑定姿势算，摆姿势后可能超出，关掉视锥剔除避免闪没
      m.frustumCulled = false;
    });
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const s = cfg.scale ?? (cfg.height ?? 1.25) / Math.max(size.y, 1e-6);
    const center = box.getCenter(new THREE.Vector3());
    // 能识别出人形骨骼就启用程序驱动：模型里没有的动作（坐、打字、托下巴…）靠它摆姿势
    const r = new HumanoidRig(obj);
    return { root: obj, scale: s, offset: new THREE.Vector3(-center.x * s, -box.min.y * s, -center.z * s), rig: r.valid ? r : null };
  }, [src, cfg.collarMaterial, cfg.scale, cfg.height, collar]);

  // 朝向：配置优先；否则用骨骼自动判断的正面
  const yaw = cfg.rotationY ?? rig?.autoYaw ?? 0;
  const avatarToModel = useMemo(() => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw), [yaw]);

  const { actions } = useAnimations(animations, group);
  const wanted = wantedActions(p);
  const seated = p.mode === 'desk' || p.mode === 'sit';
  const clipName = useMemo(() => {
    if (rig) {
      // 有骨骼驱动时只在“首选动作”（坐着时也接受坐姿）有动画才播，其余交给程序姿势，
      // 避免坐着时退回到站立待机或走路动画
      const candidates = seated ? [wanted[0], 'sit' as const] : [wanted[0]];
      for (const a of candidates) {
        const n = resolveClip(animations, cfg, a);
        if (n) return n;
      }
      return undefined;
    }
    for (const a of wanted) {
      const n = resolveClip(animations, cfg, a);
      if (n) return n;
    }
    return animations[0]?.name;
  }, [animations, cfg, rig, seated, wanted.join(',')]);
  const hasSit = useMemo(() => !!rig || !!resolveClip(animations, cfg, 'sit') || !!resolveClip(animations, cfg, 'type'), [animations, cfg, rig]);

  useEffect(() => {
    const act = clipName ? actions[clipName] : undefined;
    if (!act) return;
    act.reset().fadeIn(0.3).play();
    return () => {
      act.fadeOut(0.3);
    };
  }, [clipName, actions]);

  const phase = useMemo(() => Math.random() * 10, []);
  const curY = useRef<number | null>(null);
  const usingClip = !!(clipName && actions[clipName]);
  const wasClip = useRef(false);
  useFrame((state, dt) => {
    const g = inner.current;
    if (!g) return;
    const t = state.clock.elapsedTime + phase;
    const k = 1 - Math.exp(-dt * 8);
    let y: number;
    if (rig && usingClip) {
      // 正在播模型自带的动画（例如走路）：骨骼交给动画，只管高度
      wasClip.current = true;
      y = seated ? SEAT_HIP_Y - rig.hipY * scale : offset.y;
      if (group.current) group.current.position.z += (0 - group.current.position.z) * k;
    } else if (rig) {
      // 刚从动画切回来：从骨骼当前的实际姿态开始过渡，避免跳变
      if (wasClip.current) {
        rig.resync();
        wasClip.current = false;
      }
      // 骨骼驱动：坐下时胯部落在椅面上，站立/走路时脚踩地面
      const outer = group.current!;
      const avatarSpace = outer.parent!;
      const ik = { toAvatar: (w: THREE.Vector3) => avatarSpace.worldToLocal(w), scale };
      // 坐着时手要够得到键盘/会议桌：胳膊短的模型往前挪一点（最多 0.2m），让肩膀到桌面目标的距离在手臂长度以内
      let shift = 0;
      if (seated) {
        const S = rig.shoulderMid(ik);
        const reach = rig.armReach(scale) * 0.9;
        const needH = Math.sqrt(Math.max(0, reach * reach - (0.79 - S.y) ** 2));
        const targetZ = p.mode === 'sit' ? -0.4 : -0.42;
        shift = Math.min(0, Math.max(-0.2, targetZ + needH - (S.z - outer.position.z)));
      }
      outer.position.z += (shift - outer.position.z) * k;
      rig.apply(poseFor({ mode: p.mode, status: p.status, screen: p.screen, idleAct: p.idleAct, speaking: p.speaking, pantry: p.pantry, t }), avatarToModel, p.mode === 'walk' ? Math.min(1, k * 2.5) : k, ik);
      y = seated ? SEAT_HIP_Y - rig.hipY * scale : offset.y + (p.mode === 'walk' ? Math.abs(Math.cos(t * 9)) * 0.02 : 0);
    } else {
      y = offset.y + (seated && !hasSit ? cfg.sitLift ?? 0.4 : 0);
      if (!animations.length) {
        if (p.mode === 'walk') y += Math.abs(Math.sin(t * 9)) * 0.04;
        else if (p.status === 'working') y += Math.max(0, Math.sin(t * 16)) * 0.008;
        else y += Math.sin(t * 1.6) * 0.006;
        g.rotation.z = p.mode === 'walk' ? Math.sin(t * 9) * 0.05 : 0;
      }
    }
    curY.current = curY.current === null ? y : curY.current + (y - curY.current) * k;
    g.position.set(offset.x, curY.current, offset.z);
  });

  return (
    <group ref={group} rotation={[0, yaw, 0]}>
      <group ref={inner} scale={scale}>
        <primitive object={root} />
      </group>
    </group>
  );
}

function GltfModel(p: Props) {
  const gltf = useLoader(GLTFLoader, p.cfg.url);
  return <Rig {...p} src={gltf.scene} animations={gltf.animations} />;
}

function FbxModel(p: Props) {
  const fbx = useLoader(FBXLoader, p.cfg.url);
  return <Rig {...p} src={fbx} animations={fbx.animations ?? []} />;
}

function ObjModel(p: Props) {
  const obj = useLoader(OBJLoader, p.cfg.url);
  return <Rig {...p} src={obj} animations={[]} />;
}

function ModelByType(p: Props) {
  const ext = p.cfg.url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'fbx') return <FbxModel {...p} />;
  if (ext === 'obj') return <ObjModel {...p} />;
  return <GltfModel {...p} />;
}

/** 模型加载失败时退回内置奶蛙，不影响整个场景 */
class ModelBoundary extends Component<{ fallback: ReactNode; url: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: Error) {
    console.warn(`[avatar] 模型 ${this.props.url} 加载失败，改用内置奶蛙：`, e?.message ?? e);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function ModelPerson({ fallback, ...p }: Props & { fallback: ReactNode }) {
  return (
    <ModelBoundary fallback={fallback} url={p.cfg.url}>
      <Suspense fallback={fallback}>
        <ModelByType {...p} />
      </Suspense>
    </ModelBoundary>
  );
}
