import { useMemo } from 'react';
import { Html, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { CORRIDOR, MEETING_TABLE, WALL_H, meetingSpot, meetingTable, pantryBar, type OfficeLayout, type RoomLayout } from './layout';
import { MeetingBoard } from './MeetingBoard';
import { carpetTexture, signTexture, skylineTexture, stoneTexture, woodTexture } from './textures';
import { Chair } from './Workstation';
import { useHtmlPortal } from './hooks';

const wallMat = new THREE.MeshStandardMaterial({ color: '#ebe7e0', roughness: 0.92 });
const pillarMat = new THREE.MeshStandardMaterial({ color: '#d9d4cb', roughness: 0.85 });
const frameMat = new THREE.MeshStandardMaterial({ color: '#2f333b', metalness: 0.6, roughness: 0.35 });
const glassMat = new THREE.MeshStandardMaterial({ color: '#d6e8f3', transparent: true, opacity: 0.14, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide });
const capMat = new THREE.MeshStandardMaterial({ color: '#cfc8bc', roughness: 0.7 });
const metal = new THREE.MeshStandardMaterial({ color: '#3b3f47', metalness: 0.7, roughness: 0.35 });
const LOW_WALL = 0.55;

/** n 个等分点，取值 0..1（含两端） */
const stops = (n: number) => Array.from({ length: n }, (_, i) => (n === 1 ? 0.5 : i / (n - 1)));
const FRONT_SIDE_H = 1.15;

// ---------------- 通用墙体 ----------------

/** 沿 X 方向的玻璃隔断（固定 z），可在 doorX 处留门洞并装一扇打开的玻璃门 */
function GlassWallX({ z, x0, x1, doorX }: { z: number; x0: number; x1: number; doorX?: number }) {
  const DOOR = 1.0;
  const segs: [number, number][] = doorX === undefined ? [[x0, x1]] : [[x0, doorX - DOOR / 2], [doorX + DOOR / 2, x1]];
  return (
    <group>
      {segs.map(([a, b], i) =>
        b - a > 0.05 ? (
          <group key={i}>
            <mesh material={glassMat} position={[(a + b) / 2, WALL_H / 2, z]}>
              <planeGeometry args={[b - a, WALL_H]} />
            </mesh>
            <mesh material={frameMat} position={[(a + b) / 2, 0.03, z]}>
              <boxGeometry args={[b - a, 0.06, 0.07]} />
            </mesh>
            {stops(Math.max(1, Math.round((b - a) / 2.2)) + 1).map((f, k) => (
              <mesh key={k} material={frameMat} position={[a + (b - a) * f, WALL_H / 2, z]}>
                <boxGeometry args={[0.04, WALL_H, 0.06]} />
              </mesh>
            ))}
          </group>
        ) : null,
      )}
      <mesh material={frameMat} position={[(x0 + x1) / 2, WALL_H - 0.03, z]}>
        <boxGeometry args={[x1 - x0, 0.06, 0.08]} />
      </mesh>
      {doorX !== undefined && (
        <group>
          {/* 门框上梁 + 一扇向内打开的玻璃门 */}
          <mesh material={frameMat} position={[doorX, 2.15, z]}>
            <boxGeometry args={[DOOR, 0.06, 0.08]} />
          </mesh>
          <group position={[doorX - DOOR / 2, 0, z]} rotation={[0, z > 0 ? 1.1 : -1.1, 0]}>
            <mesh material={glassMat} position={[DOOR / 2 - 0.02, 1.07, 0]}>
              <planeGeometry args={[DOOR - 0.06, 2.1]} />
            </mesh>
            <mesh material={frameMat} position={[DOOR - 0.12, 1.05, 0.02]}>
              <boxGeometry args={[0.025, 0.4, 0.025]} />
            </mesh>
          </group>
        </group>
      )}
    </group>
  );
}

/** 沿 Z 方向的玻璃隔断（固定 x） */
function GlassWallZ({ x, z0, z1, h = WALL_H }: { x: number; z0: number; z1: number; h?: number }) {
  return (
    <group>
      <mesh material={glassMat} position={[x, h / 2, (z0 + z1) / 2]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[z1 - z0, h]} />
      </mesh>
      {[0.03, h - 0.03].map((y) => (
        <mesh key={y} material={frameMat} position={[x, y, (z0 + z1) / 2]}>
          <boxGeometry args={[0.07, 0.06, z1 - z0]} />
        </mesh>
      ))}
      {stops(Math.max(1, Math.round((z1 - z0) / 2.2)) + 1).map((f, k) => (
        <mesh key={k} material={frameMat} position={[x, h / 2, z0 + (z1 - z0) * f]}>
          <boxGeometry args={[0.06, h, 0.04]} />
        </mesh>
      ))}
    </group>
  );
}

function SolidWallZ({ x, z0, z1, h = WALL_H, out }: { x: number; z0: number; z1: number; h?: number; out: number }) {
  return (
    <group>
      <mesh material={wallMat} position={[x + out * 0.08, h / 2, (z0 + z1) / 2]} castShadow receiveShadow>
        <boxGeometry args={[0.16, h, z1 - z0 + 0.16]} />
      </mesh>
      <mesh material={capMat} position={[x + out * 0.08, h + 0.015, (z0 + z1) / 2]}>
        <boxGeometry args={[0.2, 0.03, z1 - z0 + 0.2]} />
      </mesh>
    </group>
  );
}

// ---------------- 建筑：走廊、立柱、外地坪 ----------------

export function Building({ layout }: { layout: OfficeLayout }) {
  const W = layout.width;
  const floor = useMemo(() => {
    const t = stoneTexture().clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(W / 1.2, CORRIDOR / 1.2);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.35, metalness: 0.05 });
  }, [W]);
  const back = layout.rooms.filter((r) => r.row === 'back');
  const xs = [...new Set([...back.map((r) => r.cx - r.width / 2), W / 2])];
  return (
    <group>
      {/* 楼板外沿 + 室外地面 */}
      {/* 室外地面要明显低于楼板顶面，否则两个面重合会闪烁（z-fighting） */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, (layout.minZ + layout.maxZ) / 2]} receiveShadow>
        <planeGeometry args={[W + 60, layout.maxZ - layout.minZ + 60]} />
        <meshStandardMaterial color="#c9ced4" roughness={1} />
      </mesh>
      <mesh position={[0, -0.08, (layout.minZ + layout.maxZ) / 2]} receiveShadow>
        <boxGeometry args={[W + 0.6, 0.12, layout.maxZ - layout.minZ + 0.6]} />
        <meshStandardMaterial color="#9aa1aa" roughness={0.9} />
      </mesh>
      {/* 走廊地砖 */}
      <mesh material={floor} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]} receiveShadow>
        <planeGeometry args={[W, CORRIDOR]} />
      </mesh>
      {/* 走廊两端的墙 */}
      {[-1, 1].map((s) => (
        <SolidWallZ key={s} x={(s * W) / 2} z0={-CORRIDOR / 2} z1={CORRIDOR / 2} out={s} />
      ))}
      {/* 后排外墙立柱 */}
      {xs.map((x) => (
        <mesh key={x} material={pillarMat} position={[x, WALL_H / 2, layout.minZ + 0.05]} castShadow>
          <boxGeometry args={[0.38, WALL_H, 0.38]} />
        </mesh>
      ))}
    </group>
  );
}

// ---------------- 房间 ----------------

export function Room({ room, layout, first, last }: { room: RoomLayout; layout: OfficeLayout; first: boolean; last: boolean }) {
  const { cx, cz, width: w, depth: d, kind, row } = room;
  const floor = useMemo(() => {
    const base =
      kind === 'office' || kind === 'pantry'
        ? woodTexture(kind === 'pantry' ? '#c9a27a' : '#a67b5b', kind === 'pantry' ? '#7a5534' : '#5c3d27')
        : carpetTexture(kind === 'meeting' ? '#5f6b7a' : '#7c8594');
    const t = base.clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    const wood = kind === 'office' || kind === 'pantry';
    t.repeat.set(wood ? w / 1.2 : w / 2, wood ? d * 2.2 : d / 2);
    return new THREE.MeshStandardMaterial({ map: t, roughness: wood ? 0.5 : 0.95 });
  }, [kind, w, d]);

  const north = cz - d / 2;
  const south = cz + d / 2;

  return (
    <group>
      <mesh material={floor} rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[w, d]} />
      </mesh>

      {row === 'back' ? (
        <>
          <WindowWall cx={cx} z={north} w={w} name={room.name} />
          <GlassWallX z={south} x0={cx - w / 2} x1={cx + w / 2} doorX={room.doorX} />
          {first && <SolidWallZ x={cx - w / 2} z0={north} z1={south} out={-1} />}
          {last ? <SolidWallZ x={cx + w / 2} z0={north} z1={south} out={1} /> : <GlassWallZ x={cx + w / 2} z0={north} z1={south} />}
        </>
      ) : (
        <>
          <GlassWallX z={north} x0={cx - w / 2} x1={cx + w / 2} doorX={room.doorX} />
          {/* 朝镜头的南墙做成矮墙（剖切视角），外侧挂房间名 */}
          <mesh material={wallMat} position={[cx, LOW_WALL / 2, south + 0.08]} castShadow receiveShadow>
            <boxGeometry args={[w + 0.16, LOW_WALL, 0.16]} />
          </mesh>
          <mesh material={capMat} position={[cx, LOW_WALL + 0.015, south + 0.08]}>
            <boxGeometry args={[w + 0.2, 0.03, 0.2]} />
          </mesh>
          <mesh position={[cx, LOW_WALL / 2, south + 0.185]}>
            <planeGeometry args={[1.4, 0.35]} />
            <meshBasicMaterial map={signTexture(room.name)} transparent />
          </mesh>
          {first && <SolidWallZ x={cx - w / 2} z0={north} z1={south} h={FRONT_SIDE_H} out={-1} />}
          {last ? <SolidWallZ x={cx + w / 2} z0={north} z1={south} h={FRONT_SIDE_H} out={1} /> : <GlassWallZ x={cx + w / 2} z0={north} z1={south} />}
        </>
      )}

      <group position={[cx, 0, cz]}>
        {kind === 'open' && <OpenAreaFurniture w={w} d={d} />}
        {kind === 'office' && <OfficeFurniture w={w} d={d} />}
      </group>
      {kind === 'meeting' && <MeetingRoom layout={layout} />}
      {kind === 'pantry' && <Pantry layout={layout} room={room} />}
    </group>
  );
}

/** 后排北墙：墙裙 + 落地窗 + 窗外城市 + 部门名牌 */
function WindowWall({ cx, z, w, name }: { cx: number; z: number; w: number; name: string }) {
  const windows = Math.max(2, Math.floor(w / 1.7));
  const pane = w / windows;
  const backdrop = useMemo(() => {
    // 横向平铺楼群（每 2.4m 一张），纵向只取下 70%（楼群为主，少量天空），避免拉伸变形
    const t = skylineTexture().clone();
    t.needsUpdate = true;
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(w / 2.4, 0.7);
    t.offset.set(0, 0);
    return new THREE.MeshBasicMaterial({ map: t, toneMapped: false });
  }, [w]);
  return (
    <group position={[cx, 0, z]}>
      <mesh material={wallMat} position={[0, 0.45, -0.08]} receiveShadow castShadow>
        <boxGeometry args={[w, 0.9, 0.16]} />
      </mesh>
      {/* 窗洞上方（2.1m 到顶）整段实墙 */}
      <mesh material={wallMat} position={[0, (WALL_H + 2.1) / 2, -0.08]} receiveShadow>
        <boxGeometry args={[w, WALL_H - 2.1, 0.16]} />
      </mesh>
      {Array.from({ length: windows + 1 }, (_, i) => (
        <mesh key={i} material={frameMat} position={[-w / 2 + i * pane, 1.5, -0.08]}>
          <boxGeometry args={[0.07, 1.2, 0.12]} />
        </mesh>
      ))}
      <mesh material={capMat} position={[0, 0.915, -0.02]}>
        <boxGeometry args={[w, 0.03, 0.26]} />
      </mesh>
      <mesh material={frameMat} position={[0, 2.08, -0.08]}>
        <boxGeometry args={[w, 0.05, 0.12]} />
      </mesh>
      <mesh material={glassMat} position={[0, 1.5, -0.08]}>
        <planeGeometry args={[w, 1.2]} />
      </mesh>
      {/* 窗外城市：只做成和窗洞一样大、紧贴玻璃后面，任何角度都不会从墙顶露出来 */}
      <mesh position={[0, 1.5, -0.22]} material={backdrop}>
        <planeGeometry args={[w, 1.2]} />
      </mesh>
      <mesh position={[0, WALL_H - 0.2, 0.005]}>
        <planeGeometry args={[1.6, 0.4]} />
        <meshBasicMaterial map={signTexture(name)} transparent />
      </mesh>
      <mesh position={[0, 0.04, 0.005]}>
        <boxGeometry args={[w, 0.08, 0.01]} />
        <meshStandardMaterial color="#c9c2b6" />
      </mesh>
    </group>
  );
}

// ---------------- 家具 ----------------

function Plant({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.22, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.2, 0.16, 0.44, 24]} />
        <meshStandardMaterial color="#f1ede6" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.43, 0]}>
        <cylinderGeometry args={[0.185, 0.185, 0.02, 24]} />
        <meshStandardMaterial color="#3b2a1e" roughness={1} />
      </mesh>
      {Array.from({ length: 9 }, (_, i) => {
        const a = (i / 9) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * 0.12, 0.75 + (i % 3) * 0.12, Math.sin(a) * 0.12]} rotation={[Math.sin(a) * 0.5, a, Math.cos(a) * 0.5]} scale={[1, 1.5, 0.35]} castShadow>
            <sphereGeometry args={[0.13, 12, 10]} />
            <meshStandardMaterial color={i % 2 ? '#3f7d4e' : '#4f9461'} roughness={0.75} />
          </mesh>
        );
      })}
    </group>
  );
}

function Whiteboard({ position, rotation }: { position: [number, number, number]; rotation: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.3, 0]} castShadow>
        <boxGeometry args={[1.3, 0.85, 0.03]} />
        <meshStandardMaterial color="#fafafa" roughness={0.25} />
      </mesh>
      <mesh material={frameMat} position={[0, 1.3, -0.005]}>
        <boxGeometry args={[1.36, 0.91, 0.02]} />
      </mesh>
      {[-0.55, 0.55].map((x) => (
        <mesh key={x} material={frameMat} position={[x, 0.45, 0]}>
          <boxGeometry args={[0.04, 0.9, 0.04]} />
        </mesh>
      ))}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[-0.25 + i * 0.12, 1.45 - i * 0.12, 0.017]}>
          <planeGeometry args={[0.5 - i * 0.1, 0.02]} />
          <meshBasicMaterial color={['#2563eb', '#dc2626', '#16a34a'][i]} />
        </mesh>
      ))}
    </group>
  );
}

function OpenAreaFurniture({ w, d }: { w: number; d: number }) {
  return (
    <>
      <Plant position={[-w / 2 + 0.45, 0, -d / 2 + 0.45]} />
      <Plant position={[w / 2 - 0.45, 0, -d / 2 + 0.45]} scale={0.85} />
      <Whiteboard position={[-w / 2 + 0.35, 0, d / 2 - 1.1]} rotation={Math.PI / 2 - 0.3} />
      {/* 文件柜 */}
      <mesh position={[w / 2 - 0.3, 0.4, -d / 2 + 1.4]} castShadow receiveShadow>
        <boxGeometry args={[0.45, 0.8, 0.9]} />
        <meshStandardMaterial color="#d9dbe0" roughness={0.6} metalness={0.2} />
      </mesh>
    </>
  );
}

function OfficeFurniture({ w, d }: { w: number; d: number }) {
  const sofa = useMemo(() => new THREE.MeshStandardMaterial({ color: '#5a6170', roughness: 0.9 }), []);
  return (
    <>
      <group position={[-w / 2 + 0.75, 0, -d / 2 + 0.25]}>
        <mesh position={[0, 1.0, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.2, 2.0, 0.36]} />
          <meshStandardMaterial map={woodTexture('#6e4a33', '#2e1b10')} roughness={0.6} />
        </mesh>
        {[0.35, 0.8, 1.25, 1.7].map((y, r) =>
          Array.from({ length: 7 }, (_, i) => (
            <mesh key={`${r}-${i}`} position={[-0.48 + i * 0.15 + (r % 2) * 0.03, y + 0.13, 0.08]} castShadow>
              <boxGeometry args={[0.1, 0.26 - ((i + r) % 3) * 0.03, 0.22]} />
              <meshStandardMaterial color={['#8b3a3a', '#2f4f6f', '#c9a227', '#3d6b4f', '#5a4a7a'][(i + r * 2) % 5]} roughness={0.8} />
            </mesh>
          )),
        )}
      </group>
      {/* 会客沙发（左前方，避开右侧门口和汇报站位） */}
      <group position={[-w / 2 + 1.0, 0, d / 2 - 1.6]} rotation={[0, Math.PI / 2, 0]}>
        <RoundedBox args={[1.8, 0.42, 0.8]} radius={0.06} position={[0, 0.25, 0]} material={sofa} castShadow receiveShadow />
        <RoundedBox args={[1.8, 0.5, 0.2]} radius={0.06} position={[0, 0.6, 0.32]} material={sofa} castShadow />
        {[-1, 1].map((s) => (
          <RoundedBox key={s} args={[0.2, 0.62, 0.8]} radius={0.05} position={[s * 0.9, 0.33, 0]} material={sofa} castShadow />
        ))}
        <mesh position={[0, 0.25, -0.9]} castShadow receiveShadow>
          <cylinderGeometry args={[0.38, 0.38, 0.04, 32]} />
          <meshStandardMaterial color="#f1ede6" roughness={0.3} />
        </mesh>
        <mesh material={frameMat} position={[0, 0.12, -0.9]}>
          <cylinderGeometry args={[0.03, 0.12, 0.24, 16]} />
        </mesh>
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-w / 2 + 1.5, 0.004, d / 2 - 1.6]} receiveShadow>
        <planeGeometry args={[1.8, 2.4]} />
        <meshStandardMaterial color="#c9bba6" roughness={1} />
      </mesh>
      <Plant position={[w / 2 - 0.45, 0, -d / 2 + 0.45]} />
    </>
  );
}

function PendantLamp({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, (WALL_H - position[1]) / 2, 0]}>
        <cylinderGeometry args={[0.004, 0.004, WALL_H - position[1], 4]} />
        <meshStandardMaterial color="#222" />
      </mesh>
      <mesh>
        <cylinderGeometry args={[0.08, 0.28, 0.22, 24, 1, true]} />
        <meshStandardMaterial color="#1f2937" metalness={0.5} roughness={0.4} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -0.08, 0]}>
        <sphereGeometry args={[0.07, 12, 10]} />
        <meshBasicMaterial color="#fff3d6" />
      </mesh>
      <pointLight position={[0, -0.2, 0]} intensity={0.9} distance={3.5} color="#ffe7c2" />
    </group>
  );
}

/** 会议室：长桌 + 7 把椅子 + 吊灯 + 西头的大屏（实时显示会议内容） */
function MeetingRoom({ layout }: { layout: OfficeLayout }) {
  const portal = useHtmlPortal();
  const { x: tx, z: tz, room } = meetingTable(layout);
  const { length: L, width: Wt } = MEETING_TABLE;
  const top = useMemo(() => new THREE.MeshStandardMaterial({ map: woodTexture('#5b3a26', '#2a170c'), roughness: 0.4 }), []);
  const seats = Array.from({ length: 7 }, (_, i) => meetingSpot(layout, i));
  const tvX = tx - L / 2 - 1.0;
  return (
    <group>
      <RoundedBox args={[L, 0.05, Wt]} radius={0.02} position={[tx, 0.74, tz]} material={top} castShadow receiveShadow />
      {[-1, 1].map((s) => (
        <group key={s} position={[tx + s * (L / 2 - 0.5), 0, tz]}>
          <mesh material={metal} position={[0, 0.36, 0]} castShadow>
            <boxGeometry args={[0.08, 0.72, Wt - 0.4]} />
          </mesh>
          <mesh material={metal} position={[0, 0.02, 0]}>
            <boxGeometry args={[0.3, 0.04, Wt - 0.2]} />
          </mesh>
        </group>
      ))}
      {/* 桌上的笔记本和水杯 */}
      {seats.slice(1).map((s, i) => (
        <mesh key={i} position={[s.x, 0.77, tz + (s.z > tz ? Wt / 2 - 0.25 : -Wt / 2 + 0.25)]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.21, 0.29]} />
          <meshStandardMaterial color="#f4f1ea" />
        </mesh>
      ))}
      {seats.map((s, i) => (
        <group key={i} position={[s.x, 0, s.z]} rotation={[0, s.rot, 0]}>
          <Chair manager={i === 0} />
        </group>
      ))}
      <PendantLamp position={[tx - 0.9, 2.0, tz]} />
      <PendantLamp position={[tx + 0.9, 2.0, tz]} />

      {/* 移动大屏（65 寸），朝向长桌 */}
      <group position={[tvX, 0, tz]} rotation={[0, Math.PI / 2 - 0.5, 0]}>
        {[-0.5, 0.5].map((x) => (
          <group key={x}>
            <mesh material={metal} position={[x, 0.65, 0]} castShadow>
              <boxGeometry args={[0.05, 1.3, 0.05]} />
            </mesh>
            <mesh material={metal} position={[x, 0.03, 0]}>
              <boxGeometry args={[0.08, 0.06, 0.6]} />
            </mesh>
          </group>
        ))}
        <RoundedBox args={[1.66, 0.96, 0.05]} radius={0.01} position={[0, 1.4, 0]} castShadow>
          <meshStandardMaterial color="#111215" metalness={0.4} roughness={0.3} />
        </RoundedBox>
        <Html portal={portal} transform occlude="blending" scale={1.6 / (960 * 0.025)} position={[0, 1.4, 0.027]} zIndexRange={[100, 0]} wrapperClass="html3d-passive">
          <MeetingBoard />
        </Html>
      </group>
      <Plant position={[room.cx - room.width / 2 + 0.45, 0, room.cz + room.depth / 2 - 0.5]} scale={0.8} />
    </group>
  );
}

/** 茶水间：东墙吧台（咖啡机、水槽）、冰箱、饮水机、高脚桌、沙发 */
function Pantry({ layout, room }: { layout: OfficeLayout; room: RoomLayout }) {
  const { x: bx, z: bz } = pantryBar(layout);
  const east = room.cx + room.width / 2;
  const counterZ0 = room.cz - room.depth / 2 + 0.9;
  const counterLen = 2.6;
  const stoneTop = useMemo(() => new THREE.MeshStandardMaterial({ color: '#e7e4de', roughness: 0.25 }), []);
  const cabinet = useMemo(() => new THREE.MeshStandardMaterial({ color: '#6f8f7a', roughness: 0.6 }), []);
  const sofa = useMemo(() => new THREE.MeshStandardMaterial({ color: '#c47a4f', roughness: 0.85 }), []);
  return (
    <group>
      {/* 吧台柜 + 台面 */}
      <group position={[east - 0.33, 0, counterZ0 + counterLen / 2]}>
        <mesh material={cabinet} position={[0, 0.43, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.6, 0.86, counterLen]} />
        </mesh>
        <mesh material={stoneTop} position={[0, 0.88, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.64, 0.04, counterLen + 0.04]} />
        </mesh>
        {/* 咖啡机 */}
        <group position={[0, 0.9, -0.7]}>
          <RoundedBox args={[0.32, 0.42, 0.36]} radius={0.03} position={[0, 0.21, 0]} castShadow>
            <meshStandardMaterial color="#2b2d33" metalness={0.5} roughness={0.3} />
          </RoundedBox>
          <mesh position={[-0.17, 0.3, 0]}>
            <boxGeometry args={[0.01, 0.1, 0.2]} />
            <meshBasicMaterial color="#5eead4" />
          </mesh>
          <mesh position={[-0.12, 0.05, 0]}>
            <cylinderGeometry args={[0.035, 0.03, 0.08, 16]} />
            <meshStandardMaterial color="#f2efe9" />
          </mesh>
        </group>
        {/* 水槽 */}
        <mesh position={[0, 0.895, 0.4]}>
          <boxGeometry args={[0.4, 0.02, 0.5]} />
          <meshStandardMaterial color="#9ca3af" metalness={0.8} roughness={0.2} />
        </mesh>
        {/* 果盘 */}
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[0.02 * i, 0.94, 1.0 + i * 0.06]}>
            <sphereGeometry args={[0.04, 12, 10]} />
            <meshStandardMaterial color={['#ef4444', '#f59e0b', '#84cc16'][i]} />
          </mesh>
        ))}
      </group>
      {/* 冰箱 */}
      <RoundedBox args={[0.7, 1.8, 0.7]} radius={0.04} position={[east - 0.4, 0.9, counterZ0 - 0.45]} castShadow receiveShadow>
        <meshStandardMaterial color="#e5e7eb" metalness={0.3} roughness={0.35} />
      </RoundedBox>
      {/* 饮水机 */}
      <group position={[east - 0.3, 0, counterZ0 + counterLen + 0.45]}>
        <mesh position={[0, 0.5, 0]} castShadow>
          <boxGeometry args={[0.35, 1.0, 0.35]} />
          <meshStandardMaterial color="#f8fafc" />
        </mesh>
        <mesh position={[0, 1.2, 0]} castShadow>
          <cylinderGeometry args={[0.14, 0.14, 0.4, 20]} />
          <meshStandardMaterial color="#93c5fd" transparent opacity={0.6} />
        </mesh>
      </group>
      {/* 高脚桌 + 吧凳（凳子放在斜角，四周留出站位） */}
      <mesh position={[bx, 1.05, bz]} castShadow receiveShadow>
        <cylinderGeometry args={[0.38, 0.38, 0.04, 32]} />
        <meshStandardMaterial color="#f5f1ea" roughness={0.3} />
      </mesh>
      <mesh material={metal} position={[bx, 0.52, bz]}>
        <cylinderGeometry args={[0.03, 0.03, 1.04, 12]} />
      </mesh>
      <mesh material={metal} position={[bx, 0.02, bz]}>
        <cylinderGeometry args={[0.25, 0.25, 0.03, 24]} />
      </mesh>
      {[Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4].map((a) => (
        <group key={a} position={[bx + Math.cos(a) * 0.62, 0, bz + Math.sin(a) * 0.62]}>
          <mesh position={[0, 0.72, 0]} castShadow>
            <cylinderGeometry args={[0.17, 0.17, 0.05, 20]} />
            <meshStandardMaterial color="#334155" />
          </mesh>
          <mesh material={metal} position={[0, 0.36, 0]}>
            <cylinderGeometry args={[0.02, 0.02, 0.72, 8]} />
          </mesh>
        </group>
      ))}
      {/* 沙发靠南面矮墙，朝北 */}
      <group position={[room.cx - room.width / 2 + 1.4, 0, room.cz + room.depth / 2 - 0.65]}>
        <RoundedBox args={[1.8, 0.42, 0.8]} radius={0.06} position={[0, 0.25, 0]} material={sofa} castShadow receiveShadow />
        <RoundedBox args={[1.8, 0.5, 0.2]} radius={0.06} position={[0, 0.6, 0.32]} material={sofa} castShadow />
        {[-1, 1].map((s) => (
          <RoundedBox key={s} args={[0.2, 0.62, 0.8]} radius={0.05} position={[s * 0.9, 0.33, 0]} material={sofa} castShadow />
        ))}
      </group>
      <PendantLamp position={[bx, 2.05, bz]} />
      <Plant position={[room.cx - room.width / 2 + 0.45, 0, room.cz - room.depth / 2 + 0.5]} scale={0.9} />
    </group>
  );
}
