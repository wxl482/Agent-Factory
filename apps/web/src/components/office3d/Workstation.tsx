import { memo, useMemo, useState } from 'react';
import { Html, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import type { AgentDef } from '@af/shared';
import { useStore } from '../../lib/store';
import { Screen, SCREEN_W } from '../Screen';
import { useHtmlPortal, useIdleActivity } from './hooks';
import { chairZ, KB_FROM_SEAT } from './layout';
import { keyboardTexture, woodTexture } from './textures';

/** 显示器可视区 0.6m 宽（约 27 寸）；Html 1px = 10/400 = 0.025 单位，再乘 scale */
const SCREEN_M = 0.6;
const HTML_SCALE = SCREEN_M / (SCREEN_W * 0.025);
const DESK_H = 0.74;

const metal = new THREE.MeshStandardMaterial({ color: '#3b3f47', metalness: 0.7, roughness: 0.35 });
const plastic = new THREE.MeshStandardMaterial({ color: '#1d1f24', metalness: 0.2, roughness: 0.45 });
const chairFabric = new THREE.MeshStandardMaterial({ color: '#2c2f38', roughness: 0.95 });
const leather = new THREE.MeshStandardMaterial({ color: '#4a2c20', roughness: 0.55 });
const ceramic = new THREE.MeshStandardMaterial({ color: '#f2efe9', roughness: 0.3 });

export const Workstation = memo(function Workstation({ def, manager, x, z, index }: { def: AgentDef; manager: boolean; x: number; z: number; index: number }) {
  const agent = useStore((s) => s.agents[def.id]);
  const portal = useHtmlPortal();
  const focused = useStore((s) => s.deskFocus === def.id);
  const [hover, setHover] = useState(false);
  const status = agent?.status ?? 'idle';
  const idleAct = useIdleActivity(index);
  const atDesk = (agent?.location.kind ?? 'desk') === 'desk';
  // 空闲喝咖啡时杯子在人手上
  const mugInHand = atDesk && status === 'idle' && idleAct === 'coffee';
  const deskW = manager ? 1.9 : 1.4;
  const deskD = manager ? 0.9 : 0.75;
  const seatZ = chairZ(manager);
  const kbZ = seatZ - KB_FROM_SEAT;
  const top = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: manager ? woodTexture('#6e4a33', '#2e1b10') : woodTexture('#d2b48c', '#8a6642'),
        roughness: 0.55,
      }),
    [manager],
  );

  return (
    <group
      position={[x, 0, z]}
      onClick={(e) => {
        e.stopPropagation();
        // 拖动旋转视角时松开鼠标也会触发 click，移动超过几像素就不算点击
        if (e.delta > 4) return;
        if (focused) useStore.setState({ focusAgent: def.id });
        else useStore.setState({ deskFocus: def.id });
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (e.delta > 4) return;
        useStore.setState({ focusAgent: def.id });
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = '';
      }}
    >
      {/* ---------- 桌子 ---------- */}
      <mesh material={top} position={[0, DESK_H - 0.02, 0]} castShadow receiveShadow>
        <boxGeometry args={[deskW, 0.04, deskD]} />
      </mesh>
      {manager ? (
        // 经理桌：实木柜体
        <>
          <mesh material={top} position={[-deskW / 2 + 0.25, (DESK_H - 0.04) / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.46, DESK_H - 0.04, deskD - 0.06]} />
          </mesh>
          <mesh material={top} position={[deskW / 2 - 0.25, (DESK_H - 0.04) / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.46, DESK_H - 0.04, deskD - 0.06]} />
          </mesh>
          <mesh material={top} position={[0, 0.45, -deskD / 2 + 0.04]} castShadow>
            <boxGeometry args={[deskW - 0.9, 0.5, 0.03]} />
          </mesh>
        </>
      ) : (
        <>
          {[-1, 1].map((s) => (
            <group key={s} position={[s * (deskW / 2 - 0.06), 0, 0]}>
              <mesh material={metal} position={[0, (DESK_H - 0.04) / 2, 0]} castShadow>
                <boxGeometry args={[0.05, DESK_H - 0.04, 0.05]} />
              </mesh>
              <mesh material={metal} position={[0, 0.015, 0]} castShadow>
                <boxGeometry args={[0.06, 0.03, deskD - 0.05]} />
              </mesh>
            </group>
          ))}
          <mesh material={metal} position={[0, DESK_H - 0.08, -deskD / 2 + 0.05]}>
            <boxGeometry args={[deskW - 0.12, 0.05, 0.03]} />
          </mesh>
          {/* 桌面隔板 */}
          <RoundedBox args={[deskW, 0.42, 0.03]} radius={0.012} position={[0, DESK_H + 0.21, -deskD / 2 - 0.015]} castShadow receiveShadow>
            <meshStandardMaterial color="#8792a2" roughness={0.95} />
          </RoundedBox>
        </>
      )}

      {/* ---------- 显示器 ---------- */}
      <group position={[0, 0, manager ? -0.22 : -0.2]}>
        <mesh material={plastic} position={[0, DESK_H + 0.008, -0.02]} castShadow>
          <boxGeometry args={[0.24, 0.016, 0.17]} />
        </mesh>
        <mesh material={metal} position={[0, DESK_H + 0.17, -0.06]} castShadow>
          <boxGeometry args={[0.05, 0.32, 0.025]} />
        </mesh>
        <group position={[0, 1.09, 0]}>
          <RoundedBox args={[SCREEN_M + 0.028, SCREEN_M / 1.6 + 0.035, 0.028]} radius={0.006} castShadow>
            <meshStandardMaterial color="#15161a" metalness={0.3} roughness={0.35} />
          </RoundedBox>
          {/* 屏幕：真实画面（终端/浏览器/编辑器）贴在显示器表面，可被前面的人遮挡 */}
          <Html portal={portal} transform occlude="blending" scale={HTML_SCALE} position={[0, 0.004, 0.0145]} zIndexRange={[100, 0]} wrapperClass="html3d-passive">
            <Screen agentId={def.id} scale={1} />
          </Html>
          {/* 屏幕光晕 */}
          <pointLight position={[0, 0, 0.25]} intensity={status === 'idle' ? 0.05 : 0.18} distance={1.2} color="#9ec5ff" />
        </group>
      </group>

      {/* ---------- 键盘 / 鼠标 / 杯子 / 小摆件 ---------- */}
      <mesh position={[-0.04, DESK_H + 0.012, kbZ]} castShadow receiveShadow>
        <boxGeometry args={[0.44, 0.022, 0.14]} />
        <meshStandardMaterial attach="material-0" color="#2a2c31" />
        <meshStandardMaterial attach="material-1" color="#2a2c31" />
        <meshStandardMaterial attach="material-2" map={keyboardTexture()} roughness={0.6} />
        <meshStandardMaterial attach="material-3" color="#2a2c31" />
        <meshStandardMaterial attach="material-4" color="#2a2c31" />
        <meshStandardMaterial attach="material-5" color="#2a2c31" />
      </mesh>
      <mesh position={[0.36, DESK_H + 0.002, kbZ + 0.02]} receiveShadow>
        <boxGeometry args={[0.24, 0.004, 0.2]} />
        <meshStandardMaterial color="#202227" roughness={0.9} />
      </mesh>
      <mesh material={plastic} position={[0.36, DESK_H + 0.018, kbZ + 0.02]} scale={[0.032, 0.018, 0.055]} castShadow>
        <sphereGeometry args={[1, 20, 14]} />
      </mesh>
      {!mugInHand && <Mug position={[deskW / 2 - 0.16, DESK_H, -0.08]} />}
      {index % 2 === 0 ? <Succulent position={[-deskW / 2 + 0.14, DESK_H, -0.18]} /> : <Papers position={[-deskW / 2 + 0.2, DESK_H, -0.05]} />}
      {manager && <DeskLamp position={[-deskW / 2 + 0.2, DESK_H, -0.25]} />}

      {/* ---------- 椅子（人离开时椅子被推开） ---------- */}
      <group position={[atDesk ? 0 : 0.12, 0, seatZ + (atDesk ? 0 : 0.22)]} rotation={[0, atDesk ? 0 : 0.45, 0]}>
        <Chair manager={manager} />
      </group>

      {/* 选中/悬停的地面光圈 */}
      {(hover || focused) && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0.3]}>
          <ringGeometry args={[0.95, 1.02, 48]} />
          <meshBasicMaterial color={focused ? '#fbbf24' : '#93c5fd'} transparent opacity={0.8} />
        </mesh>
      )}

    </group>
  );
});

export function Chair({ manager }: { manager?: boolean }) {
  const mat = manager ? leather : chairFabric;
  return (
    <group>
      {/* 五星脚 + 万向轮 */}
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        return (
          <group key={i} rotation={[0, a, 0]}>
            <mesh material={metal} position={[0.15, 0.07, 0]} castShadow>
              <boxGeometry args={[0.3, 0.03, 0.04]} />
            </mesh>
            <mesh material={plastic} position={[0.29, 0.028, 0]}>
              <sphereGeometry args={[0.028, 10, 10]} />
            </mesh>
          </group>
        );
      })}
      <mesh material={metal} position={[0, 0.25, 0]} castShadow>
        <cylinderGeometry args={[0.025, 0.03, 0.36, 12]} />
      </mesh>
      {/* 坐垫 */}
      <RoundedBox args={[0.52, 0.08, 0.5]} radius={0.035} position={[0, 0.46, 0.02]} material={mat} castShadow receiveShadow />
      {/* 靠背（在人身后 +Z 一侧） */}
      <mesh material={metal} position={[0, 0.58, 0.25]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[0.05, 0.25, 0.03]} />
      </mesh>
      <RoundedBox
        args={[0.48, manager ? 0.62 : 0.46, 0.08]}
        radius={0.04}
        position={[0, manager ? 0.93 : 0.84, 0.29]}
        rotation={[0.12, 0, 0]}
        material={mat}
        castShadow
      />
      {/* 扶手 */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 0.27, 0, 0.05]}>
          <mesh material={plastic} position={[0, 0.56, 0]}>
            <boxGeometry args={[0.03, 0.18, 0.03]} />
          </mesh>
          <mesh material={plastic} position={[0, 0.655, -0.02]}>
            <boxGeometry args={[0.06, 0.025, 0.24]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Succulent({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[0.045, 0.035, 0.08, 16]} />
        <meshStandardMaterial color="#d9cfc1" roughness={0.8} />
      </mesh>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <mesh key={i} position={[Math.cos(i) * 0.02, 0.1 + (i % 2) * 0.015, Math.sin(i) * 0.02]} rotation={[Math.cos(i) * 0.5, i, Math.sin(i) * 0.5]} castShadow>
          <coneGeometry args={[0.018, 0.07, 8]} />
          <meshStandardMaterial color={i % 2 ? '#5f9e6e' : '#77b28a'} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function Papers({ position }: { position: [number, number, number] }) {
  return (
    <group position={position} rotation={[0, 0.25, 0]}>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[i * 0.006, 0.004 + i * 0.006, i * 0.004]} rotation={[0, i * 0.08, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.21, 0.005, 0.297]} />
          <meshStandardMaterial color={i === 2 ? '#fdfcf7' : '#ece9e1'} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function DeskLamp({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh material={metal} position={[0, 0.01, 0]}>
        <cylinderGeometry args={[0.07, 0.08, 0.02, 20]} />
      </mesh>
      <mesh material={metal} position={[0.05, 0.2, 0]} rotation={[0, 0, -0.35]}>
        <cylinderGeometry args={[0.008, 0.008, 0.4, 8]} />
      </mesh>
      <mesh material={metal} position={[0.14, 0.38, 0]} rotation={[0, 0, -2.2]}>
        <coneGeometry args={[0.06, 0.1, 20, 1, true]} />
      </mesh>
      <pointLight position={[0.16, 0.33, 0]} intensity={0.4} distance={1.2} color="#ffd9a0" />
    </group>
  );
}

function Mug({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh material={ceramic} position={[0, 0.05, 0]} castShadow>
        <cylinderGeometry args={[0.038, 0.034, 0.1, 20]} />
      </mesh>
      <mesh material={ceramic} position={[0.045, 0.05, 0]} rotation={[0, 0, Math.PI / 2]}>
        <torusGeometry args={[0.022, 0.007, 8, 16]} />
      </mesh>
      <mesh position={[0, 0.098, 0]}>
        <cylinderGeometry args={[0.033, 0.033, 0.002, 20]} />
        <meshStandardMaterial color="#4b2e1e" roughness={0.2} />
      </mesh>
    </group>
  );
}
