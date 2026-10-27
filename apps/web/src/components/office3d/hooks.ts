import { useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type { IdleActivity } from './Person';

/** 空闲时轮流喝咖啡、刷手机；不同工位错开节奏（纯时间推算，工位和人物算出来的一致） */
export function useIdleActivity(index: number): IdleActivity {
  const pick = (): IdleActivity => (Math.floor(Date.now() / 1000 / 25 + index * 0.6) % 2 === 0 ? 'coffee' : 'phone');
  const [act, setAct] = useState<IdleActivity>(pick);
  useEffect(() => {
    const t = setInterval(() => setAct(pick()), 1000);
    return () => clearInterval(t);
  }, [index]);
  return act;
}

/**
 * drei Html 的挂载点默认取 events.connected，事件系统连上后会变，导致内部 React root 被重建；
 * 不经常重渲染的组件（如会议室大屏）重建后就一直是空的。固定挂到画布父节点上避免这个问题。
 */
export function useHtmlPortal() {
  const gl = useThree((s) => s.gl);
  return useMemo(() => ({ current: gl.domElement.parentNode as HTMLElement }), [gl]);
}
