import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { Button, ConfigProvider, Segmented } from 'antd';
import { FullscreenOutlined, RollbackOutlined } from '@ant-design/icons';
import { useStore } from '../../lib/store';
import { lightTheme } from '../../lib/ui';
import { Avatar } from './Avatar';
import { CORRIDOR, computeLayout, deskSpot, type OfficeLayout, type RoomLayout } from './layout';
import { Building, Room } from './Room';
import { Workstation } from './Workstation';

interface View {
  pos: THREE.Vector3;
  target: THREE.Vector3;
}

function roomView(r: RoomLayout): View {
  if (r.row === 'back') {
    return {
      pos: new THREE.Vector3(r.cx, 4.6 + r.width * 0.16, r.cz + r.depth / 2 + CORRIDOR * 0.6 + r.width * 0.2),
      target: new THREE.Vector3(r.cx, 0.6, r.cz - r.depth * 0.08),
    };
  }
  return {
    pos: new THREE.Vector3(r.cx, 4.2 + r.width * 0.16, r.cz + r.depth / 2 + 2.6 + r.width * 0.18),
    target: new THREE.Vector3(r.cx, 0.5, r.cz - 0.3),
  };
}

function allView(l: OfficeLayout): View {
  const w = l.width;
  return { pos: new THREE.Vector3(0, 8 + w * 0.36, l.maxZ + 3 + w * 0.42), target: new THREE.Vector3(0, 0, (l.minZ + l.maxZ) / 2 + 0.5) };
}

function deskView(l: OfficeLayout, agentId: string): View | null {
  const s = deskSpot(l, agentId);
  if (!s) return null;
  return { pos: new THREE.Vector3(s.x + 0.45, 1.85, s.z + 1.45), target: new THREE.Vector3(s.x, 1.0, s.z - 0.82) };
}

/**
 * drei 的 Html：occlude="blending"（显示器、会议大屏）会把画布放到中间层并让出指针事件，
 * 而普通 Html（名牌）挂载时又会把这些样式清掉。这里每帧强制成 blending 所需的状态：
 * 屏幕 DOM 在画布下面透过“洞”显示（能被前面的人和物体遮挡），名牌在画布上面。
 */
function BlendingLayers() {
  const gl = useThree((s) => s.gl);
  useFrame(() => {
    const st = gl.domElement.style;
    if (st.zIndex !== '8388635') {
      st.zIndex = '8388635';
      st.position = 'absolute';
      st.pointerEvents = 'none';
    }
  });
  return null;
}

/** 场景出错时不拖垮整个界面，只在控制台报错 */
class SceneBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('[office3d] 场景渲染出错：', error);
    (window as any).__sceneError = String(error?.stack ?? error);
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}

interface Controls extends THREE.EventDispatcher<{ start: object }> {
  target: THREE.Vector3;
  update(): void;
}

/** 镜头平滑飞到目标视角；用户手动拖动后停止接管 */
function CameraRig({ view }: { view: View }) {
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const camera = useThree((s) => s.camera);
  const flying = useRef(true);

  useEffect(() => {
    flying.current = true;
  }, [view]);

  useEffect(() => {
    if (!controls) return;
    const stop = () => (flying.current = false);
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);

  useFrame((_, dt) => {
    if (!flying.current || !controls) return;
    const k = 1 - Math.exp(-dt * 3.2);
    camera.position.lerp(view.pos, k);
    controls.target.lerp(view.target, k);
    controls.update();
    if (camera.position.distanceTo(view.pos) < 0.01 && controls.target.distanceTo(view.target) < 0.01) flying.current = false;
  });
  return null;
}

export function Office3D() {
  const profile = useStore((s) => s.profile);
  const dept = useStore((s) => s.dept);
  const deskFocus = useStore((s) => s.deskFocus);
  const agents = useStore((s) => s.agents);
  const meetings = useStore((s) => s.meetings);
  // 打开全屏大屏时 3D 场景被遮住，暂停渲染省资源
  const modalOpen = useStore((s) => s.focusAgent !== null || s.showNewGoal);
  const layout = useMemo(() => (profile ? computeLayout(profile) : null), [profile]);

  const view = useMemo<View | null>(() => {
    if (!layout) return null;
    if (deskFocus) {
      const v = deskView(layout, deskFocus);
      if (v) return v;
    }
    const r = layout.rooms.find((x) => x.id === dept);
    return r ? roomView(r) : allView(layout);
  }, [layout, dept, deskFocus]);

  if (!profile || !layout || !view) return <div className="office3d loading">连接中…</div>;
  const W = layout.width;
  const focusedName = deskFocus ? profile.agents.find((a) => a.id === deskFocus)?.name : null;
  const meetingLive = Object.values(meetings).some((m) => m.status !== 'done');
  const inPantry = Object.values(agents).filter((a) => a.location?.kind === 'pantry').length;

  return (
    <div className="office3d">
      <Canvas shadows camera={{ fov: 42, near: 0.1, far: 160, position: [0, 18, 26] }} dpr={[1, 1.5]} frameloop={modalOpen ? 'never' : 'always'}>
        <color attach="background" args={['#dfe4ea']} />
        <fog attach="fog" args={['#dfe4ea', 30, 90]} />
        <hemisphereLight args={['#ffffff', '#b8ab98', 0.55]} />
        <ambientLight intensity={0.22} />
        <directionalLight
          position={[W * 0.2, 12, layout.minZ - 6]}
          intensity={1.5}
          color="#fff4e2"
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0004}
          shadow-normalBias={0.03}
          shadow-camera-left={-W / 2 - 4}
          shadow-camera-right={W / 2 + 4}
          shadow-camera-top={14}
          shadow-camera-bottom={-14}
          shadow-camera-far={60}
        />
        <directionalLight position={[-4, 8, layout.maxZ + 8]} intensity={0.45} />
        <Environment resolution={256} frames={1}>
          <Lightformer form="rect" intensity={2.2} position={[0, 4, -12]} scale={[30, 4, 1]} color="#eaf4ff" />
          <Lightformer form="rect" intensity={1.2} position={[0, 10, 0]} rotation-x={Math.PI / 2} scale={[30, 30, 1]} />
          <Lightformer form="rect" intensity={0.6} position={[14, 3, 4]} rotation-y={-Math.PI / 2} scale={[12, 4, 1]} color="#ffe9d0" />
        </Environment>

        <SceneBoundary>
        <Suspense fallback={null}>
          <Building layout={layout} />
          {(['back', 'front'] as const).map((row) => {
            const rs = layout.rooms.filter((r) => r.row === row);
            return rs.map((r, i) => <Room key={r.id} room={r} layout={layout} first={i === 0} last={i === rs.length - 1} />);
          })}
          {layout.rooms.flatMap((r) =>
            r.desks.map((d, j) => {
              const def = profile.agents.find((a) => a.id === d.agentId)!;
              return <Workstation key={d.agentId} def={def} manager={d.manager} x={r.cx + d.x} z={r.cz + d.z} index={j} />;
            }),
          )}
          {profile.agents.map((def, i) => (
            <Avatar key={def.id} def={def} role={profile.roles.find((x) => x.id === def.roleId)!} layout={layout} index={i} />
          ))}
        </Suspense>
        </SceneBoundary>

        <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI / 2.08} minDistance={0.5} maxDistance={70} />
        <CameraRig view={view} />
        <BlendingLayers />
      </Canvas>

      {/* ---------- 区域切换（亮色主题，压在明亮的 3D 场景上更清晰） ---------- */}
      <ConfigProvider theme={lightTheme} button={{ autoInsertSpace: false }}>
        <div className="dept-bar">
          <Segmented
            value={deskFocus ? '' : dept}
            onChange={(v) => useStore.setState({ dept: v as string, deskFocus: null })}
            options={[
              { value: 'all', label: '🏢 全公司' },
              ...layout.rooms.map((r) => {
                const members = r.desks.map((d) => agents[d.agentId]).filter(Boolean);
                const busy = members.filter((a) => a.status === 'working' || a.status === 'thinking').length;
                const waiting = members.some((a) => a.status === 'waiting');
                return {
                  value: r.id,
                  label: (
                    <span className="dept-opt">
                      {r.kind === 'meeting' ? '🗣 ' : r.kind === 'pantry' ? '☕ ' : ''}
                      {r.name}
                      {r.kind === 'meeting' ? (
                        meetingLive && <i className="dot-live" />
                      ) : r.kind === 'pantry' ? (
                        inPantry > 0 && <small>{inPantry}人</small>
                      ) : (
                        <small>
                          {busy}/{members.length}
                        </small>
                      )}
                      {waiting && <i className="dot-wait" />}
                    </span>
                  ),
                };
              }),
            ]}
          />
        </div>
        {deskFocus && (
          <div className="desk-bar">
            <span>👀 正在看 {focusedName} 的电脑</span>
            <Button type="primary" size="small" icon={<FullscreenOutlined />} onClick={() => useStore.setState({ focusAgent: deskFocus })}>
              全屏 / 操作
            </Button>
            <Button size="small" icon={<RollbackOutlined />} onClick={() => useStore.setState({ deskFocus: null })}>
              返回
            </Button>
          </div>
        )}
      </ConfigProvider>
      <div className="office-hint">拖动旋转 · 滚轮缩放 · 右键平移 · 点击工位走近 · 双击全屏</div>
    </div>
  );
}
