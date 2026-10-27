import * as THREE from 'three';

/** 程序生成的贴图（不依赖外部资源，服务器离线也能用） */

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

const cache = new Map<string, THREE.Texture>();
function cached(key: string, make: () => THREE.Texture) {
  let t = cache.get(key);
  if (!t) cache.set(key, (t = make()));
  return t;
}

function rand(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** 地毯方块 */
export const carpetTexture = (tint: string) =>
  cached(`carpet-${tint}`, () =>
    canvasTexture(
      512,
      512,
      (ctx) => {
        ctx.fillStyle = tint;
        ctx.fillRect(0, 0, 512, 512);
        const r = rand(7);
        for (let i = 0; i < 26000; i++) {
          const v = r();
          ctx.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
          ctx.fillRect(r() * 512, r() * 512, 1.5, 1.5);
        }
        // 方块地毯拼缝，相邻块纹理方向不同
        for (let y = 0; y < 2; y++)
          for (let x = 0; x < 2; x++) {
            if ((x + y) % 2) {
              ctx.fillStyle = 'rgba(0,0,0,0.035)';
              ctx.fillRect(x * 256, y * 256, 256, 256);
            }
          }
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.lineWidth = 2;
        for (let i = 0; i <= 512; i += 256) {
          ctx.beginPath();
          ctx.moveTo(i, 0);
          ctx.lineTo(i, 512);
          ctx.moveTo(0, i);
          ctx.lineTo(512, i);
          ctx.stroke();
        }
      },
      [4, 4],
    ),
  );

/** 木纹 */
export const woodTexture = (base: string, dark: string) =>
  cached(`wood-${base}`, () =>
    canvasTexture(1024, 256, (ctx) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 1024, 256);
      const r = rand(11);
      for (let i = 0; i < 90; i++) {
        const y = r() * 256;
        ctx.strokeStyle = dark;
        ctx.globalAlpha = 0.06 + r() * 0.12;
        ctx.lineWidth = 0.6 + r() * 2.2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= 1024; x += 32) ctx.lineTo(x, y + Math.sin(x / (80 + r() * 60) + i) * (2 + r() * 4));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }),
  );

/** 键盘键帽 */
export const keyboardTexture = () =>
  cached('keyboard', () =>
    canvasTexture(512, 160, (ctx) => {
      ctx.fillStyle = '#26282e';
      ctx.fillRect(0, 0, 512, 160);
      const rows = [14, 14, 13, 12];
      rows.forEach((n, ri) => {
        const kw = 512 / 14.6;
        const off = ri * 6 + 6;
        for (let i = 0; i < n; i++) {
          ctx.fillStyle = '#3b3e46';
          ctx.fillRect(off + i * kw + 2, 8 + ri * 30, kw - 4, 24);
          ctx.fillStyle = '#4a4e57';
          ctx.fillRect(off + i * kw + 3, 9 + ri * 30, kw - 6, 4);
        }
      });
      ctx.fillStyle = '#3b3e46';
      ctx.fillRect(130, 128, 250, 24);
    }),
  );

/** 窗外：天空 + 远处楼群 */
export const skylineTexture = () =>
  cached('skyline', () =>
    canvasTexture(1024, 512, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, 512);
      g.addColorStop(0, '#8fc1ea');
      g.addColorStop(0.6, '#cfe4f4');
      g.addColorStop(1, '#eef4f8');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1024, 512);
      const r = rand(3);
      for (let layer = 0; layer < 2; layer++) {
        let x = 0;
        while (x < 1024) {
          const w = 40 + r() * 90;
          const h = (layer ? 120 : 200) + r() * (layer ? 120 : 160);
          ctx.fillStyle = layer ? '#9fb2c4' : '#b9c8d6';
          ctx.fillRect(x, 512 - h, w, h);
          ctx.fillStyle = layer ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.25)';
          for (let wy = 512 - h + 10; wy < 500; wy += 14) for (let wx = x + 6; wx < x + w - 8; wx += 12) if (r() > 0.35) ctx.fillRect(wx, wy, 6, 7);
          x += w + 4 + r() * 12;
        }
      }
    }),
  );

/** 墙上的部门名牌 */
export function signTexture(text: string) {
  return cached(`sign-${text}`, () =>
    canvasTexture(1024, 256, (ctx) => {
      ctx.clearRect(0, 0, 1024, 256);
      ctx.fillStyle = '#2f3542';
      ctx.font = '600 120px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 512, 132);
    }),
  );
}

/** 走廊地砖：浅灰石材，60cm 一块 */
export const stoneTexture = () =>
  cached('stone', () =>
    canvasTexture(512, 512, (ctx) => {
      const r = rand(23);
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) {
          const g = 214 + Math.floor(r() * 14);
          ctx.fillStyle = `rgb(${g},${g - 2},${g - 6})`;
          ctx.fillRect(x * 256, y * 256, 256, 256);
          for (let i = 0; i < 1800; i++) {
            ctx.fillStyle = r() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
            ctx.fillRect(x * 256 + r() * 256, y * 256 + r() * 256, 2, 2);
          }
        }
      ctx.strokeStyle = 'rgba(120,115,105,0.45)';
      ctx.lineWidth = 3;
      for (let i = 0; i <= 512; i += 256) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 512);
        ctx.moveTo(0, i);
        ctx.lineTo(512, i);
        ctx.stroke();
      }
    }),
  );
